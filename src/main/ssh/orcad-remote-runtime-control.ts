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
import { errorMessage } from '../../shared/error-message'
import { execCommand, isUnconfirmedSshCommandTermination } from './ssh-relay-deploy-helpers'
import {
  currentOrcadFence,
  isOrcadFenceLost,
  OrcadFenceLostError,
  posixOrcadFenceGuard
} from './orcad-activation-fence-scope'
import { orcadRemoteBaseDir, orcadWindowsHostOpCommand } from './orcad-remote-windows-node'
import { ORCAD_WINDOWS_FENCE_ARG } from './orcad-windows-host-fence-ops'
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

/** Under a held activation fence, the step runs only while the host still names this run its owner. */
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
    // A host op checks inside the host script; anything else is checked by one op just before it.
    if (!command.includes(ORCAD_WINDOWS_FENCE_ARG) && target.remoteHome) {
      const baseDir = orcadRemoteBaseDir(target.host, target.remoteHome)
      await run(orcadWindowsHostOpCommand(target.host, baseDir, 'fence-check', []))
    }
    return await run(command)
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    throw isOrcadFenceLost(error) ? new OrcadFenceLostError() : error
  }
}

/** A confirmed failure reads as `fallback`; an unconfirmed one or a lost fence propagates. */
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
  let lastWaitError: unknown
  // At least one read: a client descheduled past a short deadline must not fail a ready launch.
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
      if (isUnconfirmedSshCommandTermination(error) || error instanceof OrcadFenceLostError) {
        throw error
      }
      // Why retry: a failed read (a refused channel, a timed-out wait) says nothing about the
      // launched process. Failing the launch here makes the caller stop a healthy candidate.
      lastWaitError = error
      console.warn(`[orcad] readiness wait failed; retrying: ${errorMessage(error)}`)
      await sleep(READINESS_RETRY_PAUSE_MS)
      continue
    }
    lastWaitError = undefined
    last = parseOrcadReadinessWaitOutput(target.host, output)
    if (last.state !== 'pending') {
      return last
    }
    await sleep(READINESS_RETRY_PAUSE_MS)
  }
  if (lastWaitError !== undefined) {
    throw lastWaitError
  }
  return last
}
