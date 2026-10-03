/** Launch a slot and wait for its readiness: the one loop deploy, rollback and recovery share. */
import { ORCAD_STARTUP_READINESS_TIMEOUT_MS } from '../../shared/orcad-profile-preflight'
import {
  orcadLaunchCommand,
  parseOrcadReadinessOutput,
  type OrcadLaunchSpec,
  type OrcadReadinessParse
} from './orcad-remote-launch'
import {
  readWindowsOrcadLaunchReport,
  readWindowsOrcadSlotRuntime,
  windowsOrcadLaunchCommand,
  windowsOrcadLaunchRuntimeCommand
} from './orcad-remote-launch-windows'
import {
  ORCAD_READINESS_WAIT_MAX_SECONDS,
  orcadReadinessWaitCommand,
  parseOrcadReadinessWaitOutput
} from './orcad-remote-readiness-wait'
import type { SshConnection } from './ssh-connection'
import { execCommand } from './ssh-relay-deploy-helpers'
import { isWindowsRemoteHost, type RemoteHostPlatform } from './ssh-remote-platform'

// Only between host-side waits, so a host that answers early cannot turn this into a tight loop.
const READINESS_RETRY_PAUSE_MS = 1_000

export type OrcadRemoteExecTarget = {
  conn: SshConnection
  host: RemoteHostPlatform
  signal?: AbortSignal
  /** Locates the runtime store for host-record scripts; required on Windows, unused elsewhere. */
  remoteHome?: string
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
  if (isWindowsRemoteHost(target.host)) {
    const slotRuntime = readWindowsOrcadSlotRuntime(
      await execOrcadRemote(
        target,
        windowsOrcadLaunchRuntimeCommand(target.host, spec.remoteInstallDir)
      )
    )
    readWindowsOrcadLaunchReport(
      await execOrcadRemote(target, windowsOrcadLaunchCommand(target.host, spec, slotRuntime))
    )
  } else {
    await execOrcadRemote(target, orcadLaunchCommand(target.host, spec))
  }
  const deadline = Date.now() + (target.readinessTimeoutMs ?? ORCAD_STARTUP_READINESS_TIMEOUT_MS)
  const sleep = target.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  let last = parseOrcadReadinessOutput('')
  while (Date.now() < deadline) {
    target.signal?.throwIfAborted()
    const waitSeconds = Math.min(
      ORCAD_READINESS_WAIT_MAX_SECONDS,
      Math.ceil((deadline - Date.now()) / 1000)
    )
    last = parseOrcadReadinessWaitOutput(
      target.host,
      await execOrcadRemote(
        target,
        orcadReadinessWaitCommand(target.host, spec.remoteInstallDir, waitSeconds)
      )
    )
    if (last.state !== 'pending') {
      return last
    }
    await sleep(READINESS_RETRY_PAUSE_MS)
  }
  return last
}
