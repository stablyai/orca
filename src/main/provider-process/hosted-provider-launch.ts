import type { HostedProviderSpawn } from '../daemon/protocol/daemon-provider-process-protocol'
import type { createProviderSpawnSpec } from './provider-process-supervisor'
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

export function createHostedLaunch(
  spec: ReturnType<typeof createProviderSpawnSpec>,
  ownerPid: number,
  channel: { path: string; nonce: string }
): HostedProviderSpawn {
  const env = Object.fromEntries(
    Object.entries(spec.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
  const supervisor = JSON.parse(
    Buffer.from(env.ORCA_PROVIDER_SUPERVISOR_SPEC, 'base64').toString('utf8')
  )
  env.ORCA_PROVIDER_SUPERVISOR_SPEC = Buffer.from(
    JSON.stringify({ ...supervisor, ownerPid })
  ).toString('base64')
  env.ORCA_PROVIDER_OWNER_CHANNEL = JSON.stringify(channel)
  return {
    nonce: channel.nonce,
    source: spec.args[1],
    args: spec.args.slice(3),
    cwd: spec.cwd,
    env
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
