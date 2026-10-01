/** Launch a slot and poll its readiness file: the one loop deploy, rollback and recovery share. */
import { ORCAD_STARTUP_READINESS_TIMEOUT_MS } from '../../shared/orcad-profile-preflight'
import {
  orcadLaunchCommand,
  parseOrcadReadinessOutput,
  readOrcadReadinessCommand,
  type OrcadLaunchSpec,
  type OrcadReadinessParse
} from './orcad-remote-launch'
import type { SshConnection } from './ssh-connection'
import { execCommand } from './ssh-relay-deploy-helpers'
import type { RemoteHostPlatform } from './ssh-remote-platform'

const READINESS_POLL_MS = 500

export type OrcadRemoteExecTarget = {
  conn: SshConnection
  host: RemoteHostPlatform
  signal?: AbortSignal
}

export function execOrcadRemote(
  target: OrcadRemoteExecTarget,
  command: string,
  signal = target.signal
): Promise<string> {
  return execCommand(target.conn, command, {
    wrapCommand: target.host.commandDialect !== 'powershell',
    signal
  })
}

/** Recovery paths must finish even when the request that started them was cancelled. */
export function withoutAbortSignal<T extends { signal?: AbortSignal }>(
  options: T
): Omit<T, 'signal'> {
  const { signal: _signal, ...rest } = options
  return rest
}

export async function launchOrcadAndAwaitReadiness(
  target: OrcadRemoteExecTarget & {
    readinessTimeoutMs?: number
    sleep?: (ms: number) => Promise<void>
  },
  spec: OrcadLaunchSpec
): Promise<OrcadReadinessParse> {
  await execOrcadRemote(target, orcadLaunchCommand(target.host, spec))
  const deadline = Date.now() + (target.readinessTimeoutMs ?? ORCAD_STARTUP_READINESS_TIMEOUT_MS)
  const sleep = target.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  let last = parseOrcadReadinessOutput('')
  while (Date.now() < deadline) {
    target.signal?.throwIfAborted()
    last = parseOrcadReadinessOutput(
      await execOrcadRemote(target, readOrcadReadinessCommand(target.host, spec.remoteInstallDir))
    )
    if (last.state !== 'pending') {
      return last
    }
    await sleep(READINESS_POLL_MS)
  }
  return last
}
