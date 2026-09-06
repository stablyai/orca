import type { HostWorkspaceHostContext } from './host-workspace-host-context'
import type { RepoSummary } from './host-worktree-rpc-types'
import type { Worktree } from './workspace-list-types'
import type { WorkspaceViewSettings } from './workspace-view-settings'

export type HostWorkspaceChange = {
  type: 'ready' | 'end' | 'reposChanged' | 'worktreesChanged' | 'error'
}

export type HostWorkspaceCatalogFetch =
  // Why (STA-3123): a failed poll must stay distinguishable from an empty catalog, so the
  // host's own error code survives instead of collapsing into a generic transport failure.
  | { kind: 'request_failed'; code: string }
  // `commit` is deferred so the caller runs its own staleness check first; a superseded
  // response must not advance the binding's snapshot token.
  | { kind: 'response'; invalidShape: boolean; commit(): Worktree[] | null }

export type HostWorkspaceOperations = {
  getViewSettings(): Promise<WorkspaceViewSettings | null>
  setViewSettings(settings: WorkspaceViewSettings): Promise<void>
  listRepos(): Promise<RepoSummary[]>
  listWorkspaces(limit: number): Promise<Worktree[]>
  /**
   * Snapshot-token catalog poll. Bindings that omit it fall back to `listWorkspaces`, which
   * always transfers the full catalog and cannot report a host-side error code.
   */
  fetchWorkspaceCatalog?(hostId: string): Promise<HostWorkspaceCatalogFetch>
  /** SSH labels and host platform for multi-host catalogs; bindings that omit it keep single-host rows. */
  listHostContext?(): Promise<HostWorkspaceHostContext>
  setPinned(workspaceId: string, pinned: boolean): Promise<void>
  removeWorkspace(workspaceId: string): Promise<boolean>
  activateWorkspace(workspaceId: string): Promise<void>
  sleepWorkspace(workspaceId: string): Promise<void>
  notifyForeground(): void
  subscribeChanges(listener: (event: HostWorkspaceChange) => void): () => void
  // Why: a hosted page reads `connected` from the shell's relayed snapshot, so it can issue its
  // first catalog request a beat before that socket serves one. A direct socket omits this.
  readonly connectionStateIsRelayed?: boolean
}
