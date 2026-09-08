import { setCachedRepos } from '../cache/repo-cache'
import { getCachedWorktrees, setCachedWorktrees } from '../cache/worktree-cache'
import { loadPinnedIds, savePinnedIds } from '../storage/preferences'
import { loadHosts, updateLastConnected } from '../transport/host-store'
import type { HostScreenHostState } from './host-screen-host-state'
import type { Worktree } from './workspace-list-types'

export const nativeHostScreenHostState: HostScreenHostState = {
  cachedWorkspaces(hostId) {
    return getCachedWorktrees(hostId) as Worktree[] | null
  },
  cacheWorkspaces(hostId, workspaces) {
    setCachedWorktrees(hostId, [...workspaces])
  },
  cacheRepositories(hostId, repositories) {
    setCachedRepos(hostId, [...repositories])
  },
  loadPinnedWorkspaceIds(hostId) {
    return loadPinnedIds(hostId)
  },
  savePinnedWorkspaceIds(hostId, workspaceIds) {
    return savePinnedIds(hostId, new Set(workspaceIds))
  },
  async loadIdentity(hostId) {
    const host = (await loadHosts()).find((candidate) => candidate.id === hostId)
    return host ? { name: host.name, publicKeyB64: host.publicKeyB64 } : null
  },
  async recordConnected(hostId) {
    await updateLastConnected(hostId)
  }
}
