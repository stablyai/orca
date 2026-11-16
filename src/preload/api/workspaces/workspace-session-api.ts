import type { IssueInfo, PRInfo } from '../../../shared/github/pull-requests/pull-request-types'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../../shared/workspace-session/workspace-session-state-types'
import type { ExecutionHostId } from '../../../shared/execution-host/execution-host'
import type {
  WorkspaceSessionEntriesPatch,
  WorkspaceSessionEntriesPatchResult
} from '../../../shared/workspace-session/workspace-session-entries-patch'
import type {
  DesktopRelayWrite,
  DesktopRelayWriteResult,
  WorkspaceSessionSetOptions,
  WorkspaceSessionSetResult
} from '../../../shared/workspace-session/desktop-relay-write'
import type { TerminalSurfaceCloseTarget } from '../../../shared/workspace-layout/terminal-surfaces/terminal-surface-close-target'

export type WorkspaceSessionApi = {
  session: {
    // Omitted hostId selects the local persistence partition.
    get: (hostId?: ExecutionHostId) => Promise<WorkspaceSessionState>
    /** Read persisted partitions at boot; the host catalog may omit some. */
    listHostIds: () => Promise<ExecutionHostId[]>
    /** `relays: 'separate'`: main keeps its relay ids, applying only `carried` by ownership. */
    set: (
      args: WorkspaceSessionState,
      hostId?: ExecutionHostId,
      options?: WorkspaceSessionSetOptions
    ) => Promise<WorkspaceSessionSetResult | void>
    patch: (args: WorkspaceSessionPatch, hostId?: ExecutionHostId) => Promise<void>
    /** Changed keys only; absent where the session store takes whole fields (paired web client). */
    patchEntries?: (
      args: WorkspaceSessionEntriesPatch,
      hostId?: ExecutionHostId,
      /** This partition's relay ids, applied by ownership in the same write (see applyDesktopRelays). */
      relays?: DesktopRelayWrite['hosts'][number]
    ) => Promise<WorkspaceSessionEntriesPatchResult>
    /** The relay-write version main supports; rejects on a main without it (and absent on the paired
     *  web client), which keep relay ids in ordinary saves. */
    desktopRelaysVersion?: () => Promise<number>
    /** The window's relay ids per host, applied by main to the keys the window owns. */
    applyDesktopRelays?: (args: DesktopRelayWrite) => Promise<DesktopRelayWriteResult>
    /** Drops a closed editor file's open-file row from every non-fenced partition, atomically in main (#42761). */
    pruneClosedOpenFile: (args: { worktreeId: string; filePath: string }) => Promise<void>
    /** Commits a terminal tab or split-pane close into main's membership. */
    closeTerminalSurface: (args: {
      worktreeId: string
      target: TerminalSurfaceCloseTarget
      reason?: 'user' | 'cleanup'
    }) => Promise<void>
    flush: () => Promise<void>
    readTerminalScrollback: (args: { ref: string }) => Promise<string | null>
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
