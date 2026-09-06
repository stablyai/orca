import type { RepoSummary } from './host-worktree-rpc-types'
import type { Worktree } from './workspace-list-types'

export type HostScreenIdentity = {
  name: string
  publicKeyB64: string
}

export type HostScreenHostState = {
  cachedWorkspaces(hostId: string): Worktree[] | null
  cacheWorkspaces(hostId: string, workspaces: readonly Worktree[]): void
  cacheRepositories(hostId: string, repositories: readonly RepoSummary[]): void
  loadPinnedWorkspaceIds(hostId: string): Promise<Set<string>>
  savePinnedWorkspaceIds(hostId: string, workspaceIds: ReadonlySet<string>): Promise<void>
  loadIdentity(hostId: string): Promise<HostScreenIdentity | null>
  recordConnected(hostId: string): Promise<void>
}
