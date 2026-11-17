import type { ChildProcess } from 'node:child_process'
import type { HostedProviderSpawn } from '../daemon/protocol/daemon-provider-process-protocol'
import type { ProviderSpawnSpec } from './provider-process-supervisor'
import type { DeferredProviderOwner } from './deferred-provider-owner'
import { ProviderOwnerListener } from './provider-owner-channels'
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
  const image = await inspectMacProcessCodeIdentity(identity.pid)
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

const START_TIMEOUT_MS = 10_000

async function connectedHost(route: ProviderHostRoute): Promise<DaemonClient | null> {
  try {
    const client = await route.getClient()
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

/** Starts the native owner under the host when the host can read the chat's folder; otherwise
 * here. Either way this app holds every owner pipe, so ownership is the same as a direct launch. */
export async function launchProviderOwner(
  owner: DeferredProviderOwner,
  spec: ProviderSpawnSpec,
  route: ProviderHostRoute,
  spawnHere: () => ChildProcess
): Promise<void> {
  const client = await connectedHost(route)
  const identity =
    client && !owner.canceled
      ? await inspectHostedIdentity(client, spec.cwd, () => owner.canceled, route.reportCwd)
      : null
  if (owner.canceled) {
    owner.fail(new Error('Provider launch canceled'))
    return
  }
  if (!client || !isCurrentHostedIdentity(client, identity)) {
    launchHere(owner, spawnHere)
    return
  }
  const listener = new ProviderOwnerListener()
  let dispatched = false
  try {
    const path = await listener.listen()
    if (owner.canceled) {
      throw new Error('Provider launch canceled')
    }
    // From here a lost reply may still have started an owner, so this app never launches another.
    dispatched = true
    const { pid } = await client.request<{ pid: number }>(
      'spawnProvider',
      hostedLaunch(spec, path, listener.nonce),
      START_TIMEOUT_MS
    )
    if (!Number.isSafeInteger(pid) || pid <= 1) {
      throw new Error('Provider host returned no process')
    }
    owner.attach(pid, await withProviderStartDeadline(listener.ready, START_TIMEOUT_MS))
  } catch (error) {
    // Closing every pipe makes an owner started by an unanswered request cancel at its gate.
    void listener.ready.then(
      (pipes) => pipes.forEach((pipe) => pipe.destroy()),
      () => {}
    )
    await listener.close()
    if (dispatched || owner.canceled) {
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
