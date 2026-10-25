import { ORCAD_STARTUP_READINESS_TIMEOUT_MS } from '../../../shared/orcad-profile-preflight'
import {
  orcadLaunchCommand,
  parseOrcadReadinessOutput,
  type OrcadLaunchSpec,
  type OrcadReadinessParse
} from './orcad-remote-launch'
import {
  readWindowsOrcadLaunchReport,
  readWindowsOrcadSlotRuntime,
  readWindowsOrcadSlotEntry,
  windowsOrcadLaunchCommand,
  windowsOrcadLaunchRuntimeCommand
} from './orcad-remote-launch-windows'
import {
  ORCAD_READINESS_WAIT_MAX_SECONDS,
  orcadLaunchExitedDuringWait,
  orcadReadinessWaitCommand,
  parseOrcadReadinessWaitOutput
} from './orcad-remote-readiness-wait'
import type { OrcadHostTransport } from '../../ssh/orcad-host-transport'
import { errorMessage } from '../../../shared/error-message'
import {
  execCommand,
  isUnconfirmedSshCommandTermination
} from '../../ssh/remote-exec/remote-exec-command'
import {
  currentOrcadFence,
  isOrcadFenceLost,
  OrcadFenceLostError,
  posixOrcadFenceGuard
} from '../activation/orcad-activation-fence-scope'
import { orcadWindowsHomeOpCommand } from './orcad-remote-windows-node'
import { ORCAD_WINDOWS_FENCE_ARG } from '../host-state/orcad-windows-host-fence-ops'
import { isWindowsRemoteHost, type RemoteHostPlatform } from '../../ssh/ssh-remote-platform'

// Pause even after early host answers to avoid a tight retry loop.
const READINESS_RETRY_PAUSE_MS = 1_000

export type OrcadRemoteExecTarget = {
  conn: OrcadHostTransport
  host: RemoteHostPlatform
  signal?: AbortSignal
  /** Locates the runtime store for host-record scripts; required on Windows, unused elsewhere. */
  remoteHome?: string
}

/** A held activation fence must still name this run before any host step. */
export async function execOrcadRemote(
  target: OrcadRemoteExecTarget,
  command: string,
  signal = target.signal
): Promise<string> {
  const fence = currentOrcadFence()
  const run = (line: string): Promise<string> =>
    execCommand(target.conn, line, {
      wrapCommand: target.host.commandDialect !== 'powershell',
      signal
    })
  try {
    if (!fence) {
      return await run(command)
    }
    if (!isWindowsRemoteHost(target.host)) {
      return await run(`${posixOrcadFenceGuard(fence)} ${command}`)
    }
    // Host ops check ownership internally; other commands need a preceding check.
    if (!command.includes(ORCAD_WINDOWS_FENCE_ARG) && target.remoteHome) {
      await run(orcadWindowsHomeOpCommand(target.host, target.remoteHome, 'fence-check', []))
    }
    return await run(command)
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    throw isOrcadFenceLost(error) ? new OrcadFenceLostError() : error
  }
}

/** Only confirmed failures use fallback; unconfirmed failures and lost fences propagate. */
export function execOrcadRemoteOr(
  target: OrcadRemoteExecTarget,
  command: string,
  fallback = ''
): Promise<string> {
  return execOrcadRemote(target, command).catch((error: unknown) => {
    if (isUnconfirmedSshCommandTermination(error) || error instanceof OrcadFenceLostError) {
      throw error
    }
    return fallback
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
    const slotAnswer = await execOrcadRemote(
      target,
      windowsOrcadLaunchRuntimeCommand(target.host, spec.remoteInstallDir)
    )
    const slotRuntime = readWindowsOrcadSlotRuntime(slotAnswer)
    const slotEntry = readWindowsOrcadSlotEntry(slotAnswer, target.host, spec.remoteInstallDir)
    readWindowsOrcadLaunchReport(
      await execOrcadRemote(
        target,
        windowsOrcadLaunchCommand(target.host, spec, slotRuntime, slotEntry)
      )
    )
  } else {
    await execOrcadRemote(
      target,
      orcadLaunchCommand(
        target.host,
        spec,
        target.conn.orcadLaunchDetach ?? 'nohup',
        (await target.conn.orcadLaunchEnv?.()) ?? []
      )
    )
  }
  const deadline = Date.now() + (target.readinessTimeoutMs ?? ORCAD_STARTUP_READINESS_TIMEOUT_MS)
  const sleep = target.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  let last = parseOrcadReadinessOutput('')
  let lastWaitError: unknown
  // Always read once, even if client scheduling outlasted the deadline.
  for (let first = true; first || Date.now() < deadline; first = false) {
    target.signal?.throwIfAborted()
    const waitSeconds = Math.min(
      ORCAD_READINESS_WAIT_MAX_SECONDS,
      Math.ceil((deadline - Date.now()) / 1000)
    )
    let output: string
    try {
      output = await execOrcadRemote(
        target,
        orcadReadinessWaitCommand(target.host, spec.remoteInstallDir, waitSeconds)
      )
    } catch (error) {
      if (
        (error instanceof Error && error.name === 'AbortError') ||
        isUnconfirmedSshCommandTermination(error) ||
        error instanceof OrcadFenceLostError
      ) {
        throw error
      }
      // Failed reads do not prove launch failure; stopping here could kill a healthy candidate.
      lastWaitError = error
      console.warn(`[orcad] readiness wait failed; retrying: ${errorMessage(error)}`)
      await sleep(READINESS_RETRY_PAUSE_MS)
      continue
    }
    target.signal?.throwIfAborted()
    lastWaitError = undefined
    last = parseOrcadReadinessWaitOutput(target.host, output)
    // An exited launch answers as the deadline would, so callers attach the same log tail.
    if (last.state !== 'pending' || orcadLaunchExitedDuringWait(target.host, output)) {
      return last
    }
    await sleep(READINESS_RETRY_PAUSE_MS)
  }
  if (lastWaitError !== undefined) {
    throw lastWaitError
  }
  return last
}
