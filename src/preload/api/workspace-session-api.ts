import type { IssueInfo, PRInfo } from '../../shared/github/pull-request-types'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../shared/workspace-session-state-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { TerminalSurfaceCloseTarget } from '../../shared/terminal-surface-close-target'

export type WorkspaceSessionApi = {
  session: {
    // hostId defaults to the 'local' partition on main, so omitting it stays backward-compatible.
    get: (hostId?: ExecutionHostId) => Promise<WorkspaceSessionState>
    /** Partitions persistence holds, so boot reads them all instead of guessing from the catalog. */
    listHostIds: () => Promise<ExecutionHostId[]>
    set: (args: WorkspaceSessionState, hostId?: ExecutionHostId) => Promise<void>
    patch: (args: WorkspaceSessionPatch, hostId?: ExecutionHostId) => Promise<void>
    /** Commits a terminal tab or split-pane close into main's membership. */
    closeTerminalSurface: (args: {
      worktreeId: string
      target: TerminalSurfaceCloseTarget
      reason?: 'user' | 'cleanup'
    }) => Promise<void>
    flush: () => Promise<void>
    readTerminalScrollback: (args: { ref: string }) => string | null
  }
  cache: {
    getGitHub: () => Promise<{
      pr: Record<string, { data: PRInfo | null; fetchedAt: number }>
      issue: Record<string, { data: IssueInfo | null; fetchedAt: number }>
    }>
    setGitHub: (args: {
      cache: {
        pr: Record<string, { data: PRInfo | null; fetchedAt: number }>
        issue: Record<string, { data: IssueInfo | null; fetchedAt: number }>
      }
    }) => Promise<void>
  }
}
