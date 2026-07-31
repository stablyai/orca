import type { DaemonEndpointIdentity } from './daemon-hello-protocol'
import type {
  DaemonAuditGoneReason,
  DaemonEvidenceSource,
  DaemonProcessGoneReason,
  DaemonProcessPresentReason,
  DaemonProcessUnknownReason
} from '../../shared/daemon-audit-eligibility'

export const WINDOWS_CREATION_TIME_TOLERANCE_MS = 10_000

// Oracle contract validated 2026-07-29; omitted proofs remain unknown.
export const DAEMON_GONE_PROOFS = {
  linux: ['pid_missing', 'linux_boot_changed', 'linux_start_ticks_mismatch', 'linux_zombie'],
  darwin: ['pid_missing'],
  win32: ['windows_process_missing', 'windows_creation_time_mismatch', 'windows_named_pipe_missing']
} as const satisfies Readonly<
  Record<'linux' | 'darwin' | 'win32', readonly DaemonAuditGoneReason[]>
>

export type {
  DaemonAuditGoneReason,
  DaemonEvidenceSource,
  DaemonProcessGoneReason,
  DaemonProcessPresentReason,
  DaemonProcessUnknownReason
} from '../../shared/daemon-audit-eligibility'

export type DaemonEvidenceSources = readonly [DaemonEvidenceSource, ...DaemonEvidenceSource[]]

export type ExactDaemonIncarnation = {
  identity: DaemonEndpointIdentity
  linuxStartTicks?: string
  bootId?: string
}

export type DaemonProcessEvidence =
  | {
      state: 'present'
      reason: DaemonProcessPresentReason
      evidenceSources: DaemonEvidenceSources
    }
  | {
      state: 'gone'
      reason: DaemonProcessGoneReason
      evidenceSources: DaemonEvidenceSources
      exactIncarnation: ExactDaemonIncarnation
    }
  | {
      state: 'unknown'
      reason: DaemonProcessUnknownReason
      evidenceSources: DaemonEvidenceSources
    }

export type ProcessSignalEvidence = 'occupied' | 'permission_denied' | 'missing' | 'unavailable'

export type LinuxStatEvidence =
  | { status: 'present'; value: string }
  | { status: 'missing' }
  | { status: 'unavailable' }

export type WindowsProcessEvidence =
  | { status: 'present'; commandLine: string | null; startedAtMs: number | null }
  | { status: 'missing' }
  | { status: 'unavailable' }

export type DaemonProcessProbeDependencies = {
  platform?: NodeJS.Platform
  signalProcess?: (pid: number) => ProcessSignalEvidence
  readLinuxStat?: (pid: number) => Promise<LinuxStatEvidence>
  readBootIdentity?: () => Promise<string | undefined>
  readCommandLine?: (pid: number, platform: NodeJS.Platform) => Promise<string | undefined>
  readProcessStartedAtMs?: (pid: number) => number | null
  queryWindowsProcess?: (pid: number) => Promise<WindowsProcessEvidence>
}
