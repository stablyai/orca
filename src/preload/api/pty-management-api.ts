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
  | { contact: 'unverifiable'; reason: 'listing-failed'; detail: string | null }
)

// 'severed': macOS can no longer attribute daemon terminals to Orca, so Accessibility/
// Automation grants silently stop applying until the daemon is restarted (STA-3491).
export type PtyManagementMacTccAttributionHealth = 'intact' | 'severed' | 'unknown'

export type PtyManagementApi = {
  // `degraded`: daemon is alive but can't spawn fresh PTYs, so new terminals run locally without daemon persistence.
  listSessions: () => Promise<{ generations: PtyManagementGeneration[]; degraded: boolean }>
  killAll: () => Promise<{
    killedCount: number
    remainingCount: number
    killedSessionIds?: string[]
  }>
  killOne: (args: { sessionId: string }) => Promise<{ success: boolean }>
  restart: () => Promise<{ success: boolean }>
  macTccAttribution: () => Promise<{ health: PtyManagementMacTccAttributionHealth }>
}
