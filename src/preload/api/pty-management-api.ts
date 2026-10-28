import type { DaemonPtyCwdClass } from '../../shared/daemon-adoption-telemetry'
import type { DaemonAsyncIoStatus } from '../../shared/daemon-async-io-health'

// Mirrors DaemonSessionInfo; preload cannot import main-only daemon protocol types.
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
}

// severed: macOS privacy grants stop applying to daemon terminals until daemon restart.
export type PtyManagementMacTccAttributionHealth = 'intact' | 'severed' | 'unknown'

export type PtyManagementDaemonCwdClass = DaemonPtyCwdClass

// Access a fresh daemon would get: allowed needs restart; denied needs renewed Orca permission.
export type PtyManagementFreshDaemonAccess = 'allowed' | 'denied' | 'unknown'

// The daemon cannot read a folder Orca can.
export type PtyManagementFolderAccessMismatch = {
  /** Opaque per-daemon digest used to latch the notice, never a path. */
  daemonScope: string
  cwdClass: PtyManagementDaemonCwdClass
  freshDaemonAccess: PtyManagementFreshDaemonAccess
}

// Mirrors DaemonFolderAccessResetResult; probed carries the post-reset mismatch verdict.
export type PtyManagementFolderAccessResetResult =
  | { outcome: 'unsupported' }
  | { outcome: 'reset_failed' }
  | { outcome: 'probed'; mismatch: PtyManagementFolderAccessMismatch | null }

// Mirrors SeveredDaemonStatus: a live Linux AppImage daemon whose program files are gone.
export type PtyManagementSeveredDaemon = {
  pid: number
  linuxStartTicks: string
  bootId: string
  liveSessionCount: number | null
}

export type PtyManagementSeveredDaemonRestartResult =
  | { status: 'restarted'; killedCount: number }
  | { status: 'refused'; reason: 'not-severed' | 'replaced' | 'unverifiable' }

export type PtyManagementApi = {
  asyncIoHealth: () => Promise<DaemonAsyncIoStatus>
  // degraded: new PTYs fall back to local spawning without daemon persistence.
  listSessions: () => Promise<{ sessions: PtyManagementSession[]; degraded: boolean }>
  killAll: () => Promise<{
    killedCount: number
    remainingCount: number
    killedSessionIds?: string[]
    /** Some sessions could not be listed, so the counts may miss some. */
    listingIncomplete?: boolean
  }>
  killOne: (args: { sessionId: string }) => Promise<{ success: boolean }>
  restart: () => Promise<{ success: boolean }>
  macTccAttribution: () => Promise<{
    health: PtyManagementMacTccAttributionHealth
    folderAccessMismatch: PtyManagementFolderAccessMismatch | null
  }>
  resetFolderAccess: () => Promise<PtyManagementFolderAccessResetResult>
  severedDaemon: () => Promise<{ severed: PtyManagementSeveredDaemon | null }>
  restartSeveredDaemon: (
    expected: Pick<PtyManagementSeveredDaemon, 'pid' | 'linuxStartTicks' | 'bootId'>
  ) => Promise<PtyManagementSeveredDaemonRestartResult>
}
