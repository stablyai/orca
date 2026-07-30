import { parseLinuxStartTicks, readBootIdentity } from '../agent-hooks/managed-hook-owner-identity'
import {
  commandLineMatchesDaemon,
  getProcessStartedAtMs,
  startTimesWithinTolerance
} from './daemon-health'
import {
  WINDOWS_CREATION_TIME_TOLERANCE_MS,
  type DaemonEvidenceSources,
  type DaemonProcessEvidence,
  type DaemonProcessProbeDependencies,
  type ExactDaemonIncarnation,
  type ProcessSignalEvidence
} from './daemon-incarnation-evidence-types'
import {
  inspectProcessSignal,
  queryWindowsProcess,
  readLinuxStat,
  readProcessCommandLine
} from './daemon-process-inspection'

export {
  DAEMON_GONE_PROOFS,
  WINDOWS_CREATION_TIME_TOLERANCE_MS,
  type DaemonEvidenceSource,
  type DaemonEvidenceSources,
  type DaemonProcessEvidence,
  type DaemonProcessProbeDependencies,
  type ExactDaemonIncarnation,
  type LinuxStatEvidence,
  type ProcessSignalEvidence,
  type WindowsProcessEvidence
} from './daemon-incarnation-evidence-types'

const POSIX_START_TIME_TOLERANCE_MS = 1_500

export async function probeDaemonProcessIdentity(
  exactIncarnation: ExactDaemonIncarnation | null,
  endpoint: { socketPath: string; tokenPath: string },
  dependencies: DaemonProcessProbeDependencies = {}
): Promise<DaemonProcessEvidence> {
  if (!exactIncarnation) {
    return unknown('exact_identity_unavailable', ['pid_record'])
  }
  const platform = dependencies.platform ?? process.platform
  const signalProcess = dependencies.signalProcess ?? inspectProcessSignal
  const signal = signalProcess(exactIncarnation.identity.pid)
  if (platform !== 'win32' && signal === 'missing') {
    return gone('pid_missing', ['process_signal', 'endpoint_identity'], exactIncarnation)
  }

  if (platform === 'linux') {
    return await probeLinuxProcess(exactIncarnation, endpoint, signal, dependencies)
  }
  if (platform === 'win32') {
    return await probeWindowsProcess(exactIncarnation, endpoint, signal, dependencies)
  }
  return await probeMacosProcess(exactIncarnation, endpoint, signal, dependencies)
}

async function probeLinuxProcess(
  exactIncarnation: ExactDaemonIncarnation,
  endpoint: { socketPath: string; tokenPath: string },
  signal: ProcessSignalEvidence,
  dependencies: DaemonProcessProbeDependencies
): Promise<DaemonProcessEvidence> {
  const stat = await (dependencies.readLinuxStat ?? readLinuxStat)(exactIncarnation.identity.pid)
  if (stat.status === 'missing') {
    return gone('pid_missing', ['linux_proc_stat', 'endpoint_identity'], exactIncarnation)
  }
  if (stat.status === 'unavailable') {
    return unknown(signal === 'permission_denied' ? 'permission_denied' : 'inspection_failed', [
      'linux_proc_stat',
      'process_signal'
    ])
  }

  const expectedTicks = exactIncarnation.linuxStartTicks
  const expectedBootId = exactIncarnation.bootId
  if (expectedTicks || expectedBootId) {
    if (!expectedTicks || !expectedBootId) {
      return unknown('linux_identity_incomplete', ['pid_record'])
    }
    const bootId = await (dependencies.readBootIdentity ?? readBootIdentity)()
    if (!bootId) {
      return unknown('inspection_failed', ['boot_identity'])
    }
    if (bootId !== expectedBootId) {
      return gone(
        'linux_boot_changed',
        ['boot_identity', 'pid_record', 'endpoint_identity'],
        exactIncarnation
      )
    }
    const currentTicks = parseLinuxStartTicks(stat.value)
    if (!currentTicks) {
      return unknown('inspection_failed', ['linux_proc_stat'])
    }
    if (currentTicks !== expectedTicks) {
      return gone(
        'linux_start_ticks_mismatch',
        ['linux_proc_stat', 'boot_identity', 'pid_record'],
        exactIncarnation
      )
    }
    if (parseLinuxProcessState(stat.value) === 'Z') {
      return gone(
        'linux_zombie',
        ['linux_proc_stat', 'boot_identity', 'pid_record'],
        exactIncarnation
      )
    }
  }

  const commandLine = await (dependencies.readCommandLine ?? readProcessCommandLine)(
    exactIncarnation.identity.pid,
    'linux'
  )
  if (commandLine === undefined) {
    return unknown('command_line_unavailable', ['process_command_line'])
  }
  if (!commandLineMatchesDaemon(commandLine, endpoint.socketPath, endpoint.tokenPath)) {
    return unknown('command_line_mismatch', ['process_command_line'])
  }
  if (expectedTicks && expectedBootId) {
    return present('linux_identity_match', [
      'linux_proc_stat',
      'boot_identity',
      'process_command_line',
      'endpoint_identity'
    ])
  }

  const startedAtMs = (dependencies.readProcessStartedAtMs ?? getProcessStartedAtMs)(
    exactIncarnation.identity.pid
  )
  if (startedAtMs === null) {
    return unknown('process_start_time_unavailable', ['process_start_time'])
  }
  return startTimesWithinTolerance(
    startedAtMs,
    exactIncarnation.identity.startedAtMs,
    POSIX_START_TIME_TOLERANCE_MS
  )
    ? present('linux_identity_match', [
        'process_command_line',
        'process_start_time',
        'endpoint_identity'
      ])
    : unknown('linux_identity_incomplete', ['process_start_time', 'endpoint_identity'])
}

async function probeMacosProcess(
  exactIncarnation: ExactDaemonIncarnation,
  endpoint: { socketPath: string; tokenPath: string },
  signal: ProcessSignalEvidence,
  dependencies: DaemonProcessProbeDependencies
): Promise<DaemonProcessEvidence> {
  const commandLine = await (dependencies.readCommandLine ?? readProcessCommandLine)(
    exactIncarnation.identity.pid,
    'darwin'
  )
  if (commandLine === undefined) {
    return unknown(
      signal === 'permission_denied' ? 'permission_denied' : 'command_line_unavailable',
      ['process_command_line', 'process_signal']
    )
  }
  if (!commandLineMatchesDaemon(commandLine, endpoint.socketPath, endpoint.tokenPath)) {
    return unknown('command_line_mismatch', ['process_command_line'])
  }
  const startedAtMs = (dependencies.readProcessStartedAtMs ?? getProcessStartedAtMs)(
    exactIncarnation.identity.pid
  )
  if (startedAtMs === null) {
    return unknown('process_start_time_unavailable', ['process_start_time'])
  }
  return startTimesWithinTolerance(
    startedAtMs,
    exactIncarnation.identity.startedAtMs,
    POSIX_START_TIME_TOLERANCE_MS
  )
    ? present('macos_identity_match', [
        'process_command_line',
        'process_start_time',
        'endpoint_identity'
      ])
    : unknown('macos_start_time_mismatch', ['process_start_time', 'endpoint_identity'])
}

async function probeWindowsProcess(
  exactIncarnation: ExactDaemonIncarnation,
  endpoint: { socketPath: string; tokenPath: string },
  signal: ProcessSignalEvidence,
  dependencies: DaemonProcessProbeDependencies
): Promise<DaemonProcessEvidence> {
  const identity = await (dependencies.queryWindowsProcess ?? queryWindowsProcess)(
    exactIncarnation.identity.pid
  )
  if (identity.status === 'missing') {
    return gone('windows_process_missing', ['windows_cim', 'endpoint_identity'], exactIncarnation)
  }
  if (identity.status === 'unavailable') {
    return unknown(signal === 'permission_denied' ? 'permission_denied' : 'inspection_failed', [
      'windows_cim',
      'process_signal'
    ])
  }
  if (identity.startedAtMs === null) {
    return unknown('windows_process_start_time_unavailable', ['windows_cim'])
  }
  if (
    !startTimesWithinTolerance(
      identity.startedAtMs,
      exactIncarnation.identity.startedAtMs,
      WINDOWS_CREATION_TIME_TOLERANCE_MS
    )
  ) {
    return gone(
      'windows_creation_time_mismatch',
      ['windows_cim', 'endpoint_identity'],
      exactIncarnation
    )
  }
  return present(
    'windows_identity_match',
    identity.commandLine &&
      commandLineMatchesDaemon(identity.commandLine, endpoint.socketPath, endpoint.tokenPath)
      ? ['windows_cim', 'process_command_line', 'endpoint_identity']
      : ['windows_cim', 'endpoint_identity']
  )
}

export function parseLinuxProcessState(statLine: string): string | null {
  const commandEnd = statLine.lastIndexOf(')')
  if (commandEnd < 0) {
    return null
  }
  return (
    statLine
      .slice(commandEnd + 1)
      .trim()
      .split(/\s+/, 1)[0] ?? null
  )
}

function present(
  reason: Extract<DaemonProcessEvidence, { state: 'present' }>['reason'],
  evidenceSources: DaemonEvidenceSources
): DaemonProcessEvidence {
  return { state: 'present', reason, evidenceSources }
}

function gone(
  reason: Extract<DaemonProcessEvidence, { state: 'gone' }>['reason'],
  evidenceSources: DaemonEvidenceSources,
  exactIncarnation: ExactDaemonIncarnation
): DaemonProcessEvidence {
  return { state: 'gone', reason, evidenceSources, exactIncarnation }
}

function unknown(
  reason: Extract<DaemonProcessEvidence, { state: 'unknown' }>['reason'],
  evidenceSources: DaemonEvidenceSources
): DaemonProcessEvidence {
  return { state: 'unknown', reason, evidenceSources }
}
