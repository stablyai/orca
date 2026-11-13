import type { HostedProviderSpawn } from '../daemon/protocol/daemon-provider-process-protocol'
import type { createProviderSpawnSpec } from './provider-process-supervisor'
import type { DaemonClient } from '../daemon/transport/client/daemon-client'
import type { DaemonEndpointIdentity } from '../daemon/protocol/daemon-hello-protocol'
import { inspectMacProcessCodeIdentity } from '../daemon/executable-host/macos/daemon-mac-code-identity'

export async function inspectHostedIdentity(
  client: DaemonClient
): Promise<DaemonEndpointIdentity | null> {
  const identity = client.getDaemonIdentity()
  if (!identity?.providerSpawn) {
    return null
  }
  const image = await inspectMacProcessCodeIdentity(identity.pid)
  return image.executablePath && (image.identity === 'resolved' || image.identity === 'parked')
    ? identity
    : null
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
