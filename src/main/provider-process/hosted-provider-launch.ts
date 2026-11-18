import type { ChildProcess } from 'node:child_process'
import { withTimeout } from '../../shared/concurrency/promise-timeout-fallback'
import type {
  HostedProviderSpawn,
  HostedProviderSpawnResult
} from '../daemon/protocol/daemon-provider-process-protocol'
import type { ProviderSpawnSpec } from './provider-process-supervisor'
import type { DeferredProviderOwner } from './deferred-provider-owner'
import { ProviderOwnerListener } from './provider-owner-channels'
import { PROVIDER_BOOTSTRAP_DEADLINE_MS } from './provider-bootstrap-status'
import { OWNERSHIP_PROOF_WINDOW_MS } from './provider-ownership-launch-proof'
import type { DaemonClient } from '../daemon/transport/client/daemon-client'
import type { DaemonEndpointIdentity } from '../daemon/protocol/daemon-hello-protocol'
import { inspectMacProcessCodeIdentity } from '../daemon/executable-host/macos/daemon-mac-code-identity'
import type { DirectoryEnumerationOutcome } from '../daemon/permissions/directory-enumeration-probe'
import { sameDaemonIdentity } from '../daemon/transport/client/daemon-client-hello-handshake'

export type HostedCwdReporter = (verdict: {
  cwd: string
  cwdReadableByDaemon: boolean
  daemonIdentity: DaemonEndpointIdentity
}) => void

export function isCurrentHostedIdentity(
  client: DaemonClient,
  identity: DaemonEndpointIdentity | null
): identity is DaemonEndpointIdentity {
  const current = client.getDaemonIdentity()
  return (
    identity !== null && current?.providerSpawn === true && sameDaemonIdentity(identity, current)
  )
}

async function probeHostedCwd(
  client: DaemonClient,
  cwd: string
): Promise<DirectoryEnumerationOutcome | null> {
  try {
    const reply = await client.request<{ outcome?: unknown } | null>(
      'probeProviderCwd',
      { cwd },
      1_500
    )
    const outcome = reply?.outcome
    return outcome === 'ok' || outcome === 'denied' || outcome === 'missing' || outcome === 'other'
      ? outcome
      : null
  } catch {
    // No spawn was sent: old hosts and unanswered permission reads keep GUI-owned launching.
    return null
  }
}

const HOST_IMAGE_REUSE_MS = 10_000
let lastHostImage: {
  identity: DaemonEndpointIdentity
  readAt: number
  image: ReturnType<typeof inspectMacProcessCodeIdentity>
} | null = null

/** A burst of launches shares one signature read; a host's bundle can still vanish later. */
function hostCodeIdentity(
  identity: DaemonEndpointIdentity
): ReturnType<typeof inspectMacProcessCodeIdentity> {
  const now = performance.now()
  if (
    !lastHostImage ||
    !sameDaemonIdentity(lastHostImage.identity, identity) ||
    now - lastHostImage.readAt > HOST_IMAGE_REUSE_MS
  ) {
    lastHostImage = { identity, readAt: now, image: inspectMacProcessCodeIdentity(identity.pid) }
  }
  return lastHostImage.image
}

export async function inspectHostedIdentity(
  client: DaemonClient,
  cwd: string,
  isCanceled: () => boolean,
  reportCwd: HostedCwdReporter
): Promise<DaemonEndpointIdentity | null> {
  const identity = client.getDaemonIdentity()
  if (!identity?.providerSpawn) {
    return null
  }
  const image = await hostCodeIdentity(identity)
  if (image.identity !== 'resolved' && image.identity !== 'parked') {
    // A failed read may be transient; the next launch reads again.
    lastHostImage = null
  }
  if (
    isCanceled() ||
    !image.executablePath ||
    (image.identity !== 'resolved' && image.identity !== 'parked') ||
    !isCurrentHostedIdentity(client, identity)
  ) {
    return null
  }
  const outcome = await probeHostedCwd(client, cwd)
  if (isCanceled() || !isCurrentHostedIdentity(client, identity)) {
    return null
  }
  if (outcome === 'ok' || outcome === 'denied') {
    try {
      reportCwd({ cwd, cwdReadableByDaemon: outcome === 'ok', daemonIdentity: identity })
    } catch {
      // Notice bookkeeping must never prevent launching a chat.
    }
  }
  return outcome === 'ok' ? identity : null
}

export type ProviderHostRoute = {
  getClient: () => Promise<DaemonClient | null>
  reportCwd: HostedCwdReporter
}

// The bootstrap deadline starts with the launch; whichever owner attaches still needs time for
// its ownership proof, so a failed hosted start always leaves a direct launch enough of it.
const HOSTED_START_BUDGET_MS = PROVIDER_BOOTSTRAP_DEADLINE_MS - OWNERSHIP_PROOF_WINDOW_MS - 1_000

async function connectedHost(route: ProviderHostRoute): Promise<DaemonClient | null> {
  try {
    // A host still starting must not hold a chat past its bootstrap deadline; launch here instead.
    const client = await withTimeout(route.getClient(), 1_000, null)
    if (!client) {
      return null
    }
    await client.ensureConnectedWithin(1_000)
    if (!client.getDaemonIdentity()?.providerSpawn) {
      return null
    }
    // No spawn has been sent yet, so a hung host can safely use the direct launch path.
    await client.request('ping', undefined, 1_000)
    return client
  } catch {
    return null
  }
}

function hostedLaunch(spec: ProviderSpawnSpec, path: string, nonce: string): HostedProviderSpawn {
  const env = Object.fromEntries(
    Object.entries(spec.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
  return { nonce, path, program: spec.program, args: spec.args, cwd: spec.cwd, env }
}

function launchHere(owner: DeferredProviderOwner, spawn: () => ChildProcess): void {
  let child: ChildProcess
  try {
    child = spawn()
  } catch (error) {
    owner.fail(error instanceof Error ? error : new Error(String(error)))
    return
  }
  if (child.pid === undefined) {
    child.once('error', (error) => owner.fail(error))
    return
  }
  owner.attach(child.pid, new Map(child.stdio.map((stream, fd) => [fd, stream])))
}

/** Starts the native owner under the host when the host can read the chat's folder, and here
 * otherwise or when the host's start fails before attach. Either way this app holds every owner
 * pipe, so ownership is the same as a direct launch. */
export async function launchProviderOwner(
  owner: DeferredProviderOwner,
  spec: ProviderSpawnSpec,
  route: ProviderHostRoute,
  spawnHere: () => ChildProcess
): Promise<void> {
  const deadline = performance.now() + HOSTED_START_BUDGET_MS
  const remainingMs = (): number => Math.max(0, deadline - performance.now())
  // Checks still running past the budget must not report a verdict the direct launch has outlived.
  const abandoned = (): boolean => owner.canceled || remainingMs() === 0
  // Connecting, signature and folder checks share the budget, so a slow host can't spend it all.
  const { client, identity } = await withProviderStartDeadline(
    (async () => {
      const client = await connectedHost(route)
      const identity =
        client && !owner.canceled
          ? await inspectHostedIdentity(client, spec.cwd, abandoned, route.reportCwd)
          : null
      return { client, identity }
    })(),
    remainingMs()
  ).catch(() => ({ client: null, identity: null }))
  if (owner.canceled) {
    owner.fail(new Error('Provider launch canceled'))
    return
  }
  if (!client || !isCurrentHostedIdentity(client, identity)) {
    launchHere(owner, spawnHere)
    return
  }
  const listener = new ProviderOwnerListener()
  let attached = false
  try {
    const path = await listener.listen()
    if (owner.canceled) {
      throw new Error('Provider launch canceled')
    }
    // A reconnect may have reached a host that never read this folder.
    if (!isCurrentHostedIdentity(client, identity)) {
      throw new Error('Provider host changed before launch')
    }
    if (remainingMs() === 0) {
      throw new Error('Provider host start ran out of time')
    }
    // A timer, not only the request's own timeout, so a stalled event loop still falls back in time.
    const result = await withProviderStartDeadline(
      client.request<HostedProviderSpawnResult>(
        'spawnProvider',
        hostedLaunch(spec, path, listener.nonce),
        remainingMs()
      ),
      remainingMs()
    )
    if ('spawnError' in result) {
      const { code, path: failedPath } = result.spawnError
      throw Object.assign(new Error(`spawn ${failedPath ?? spec.program} ${code}`), {
        code,
        ...(failedPath ? { path: failedPath } : {})
      })
    }
    const { pid } = result
    if (!Number.isSafeInteger(pid) || pid <= 1) {
      throw new Error('Provider host returned no process')
    }
    const pipes = await withProviderStartDeadline(listener.ready, remainingMs())
    // Only attaching can open the owner's gate, so until here no CLI ran and no input left this app.
    attached = true
    owner.attach(pid, pipes)
  } catch (error) {
    // Closing every pipe makes an owner started by an unanswered request exit at its gate.
    void listener.ready.then(
      (pipes) => pipes.forEach((pipe) => pipe.destroy()),
      () => {}
    )
    await listener.close()
    if (attached || owner.canceled) {
      owner.fail(error instanceof Error ? error : new Error('Provider could not start'))
    } else {
      launchHere(owner, spawnHere)
    }
  }
}

export async function withProviderStartDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Provider launch timed out')), timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
