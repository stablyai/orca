import type { DaemonPtyCwdClass } from '../../shared/daemon-adoption-telemetry'

// Mirror of daemon's `DaemonSessionInfo` (src/main/daemon/types.ts); not imported — preload can't depend on main-only protocol types.
export type PtyManagementSession = {
  sessionId: string
  state: 'created' | 'spawning' | 'running' | 'exiting' | 'exited'
  shellState: 'pending' | 'ready' | 'timed_out' | 'unsupported'
  isAlive: boolean
  pid: number | null
  cwd: string | null
  cols: number
  rows: number
  createdAt: number
  protocolVersion: number
  incarnationId?: string
  /** The copy an open tab shows; a same-id copy in another version does not. */
  backsTab: boolean
}

/**
 * Mirror of main's `DaemonGenerationInventory` (src/main/ipc/pty-management.ts).
 *
 * A generation Orca could not reach is `unverifiable` and carries no session list: an empty
 * array would read as a counted zero, and a listing this process could not complete is never
 * evidence that the generation's terminals exited (docs/reference/ssh-execution-boundary.md).
 */
export type PtyManagementGeneration = { protocolVersion: number; isCurrent: boolean } & (
  | { contact: 'live'; sessions: PtyManagementSession[] }
  | { contact: 'exited' }
  | { contact: 'unverifiable'; reason: 'listing-failed'; detail: string | null }
)

/** One row's exact identity: the same id can be live in two daemon versions at once. */
export type PtyManagementSessionIdentity = Pick<
  PtyManagementSession,
  'sessionId' | 'protocolVersion' | 'incarnationId'
>

// 'severed': macOS can no longer attribute daemon terminals to Orca, so Accessibility/
// Automation grants silently stop applying until the daemon is restarted (STA-3491).
export type PtyManagementMacTccAttributionHealth = 'intact' | 'severed' | 'unknown'

export type PtyManagementDaemonCwdClass = DaemonPtyCwdClass

// The daemon spawned a terminal into a folder it can't read while Orca can (STA-7948).
// `daemonScope` is an opaque per-daemon digest, never a path — it only latches the notice.
// `freshDaemonAccess` is what a daemon forked now would get: 'allowed' means restarting is the
// whole remedy, 'denied' means Orca must be re-allowed first, 'unknown' means main could not tell.
export type PtyManagementFreshDaemonAccess = 'allowed' | 'denied' | 'unknown'

export type PtyManagementFolderAccessMismatch = {
  daemonScope: string
  cwdClass: PtyManagementDaemonCwdClass
  freshDaemonAccess: PtyManagementFreshDaemonAccess
}

// Mirrors DaemonFolderAccessResetResult in src/main/daemon/daemon-folder-access-reset.ts.
// 'unsupported': nothing to reset, or the platform/app bundle cannot support one.
// 'reset_failed': tccutil refused. 'probed': the reset ran and `mismatch` is the fresh verdict.
export type PtyManagementFolderAccessResetResult =
  | { outcome: 'unsupported' }
  | { outcome: 'reset_failed' }
  | { outcome: 'probed'; mismatch: PtyManagementFolderAccessMismatch | null }

export type PtyManagementApi = {
  // `degraded`: daemon is alive but can't spawn fresh PTYs, so new terminals run locally without daemon persistence.
  listSessions: () => Promise<{ generations: PtyManagementGeneration[]; degraded: boolean }>
  killAll: () => Promise<{
    killedCount: number
    remainingCount: number
    unverifiedCount?: number
    unreachedVersionCount?: number
    killedSessionIds?: string[]
  }>
  killOne: (
    args: PtyManagementSessionIdentity
  ) => Promise<{ success: boolean; reason?: 'unverifiable' }>
  restart: () => Promise<{ success: boolean }>
  macTccAttribution: () => Promise<{
    health: PtyManagementMacTccAttributionHealth
    folderAccessMismatch: PtyManagementFolderAccessMismatch | null
  }>
  resetFolderAccess: () => Promise<PtyManagementFolderAccessResetResult>
}
