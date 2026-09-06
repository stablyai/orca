import { getCachedWorktrees, setCachedWorktrees } from '../cache/worktree-cache'
import type { HostScreenHostState, HostScreenIdentity } from './host-screen-host-state'
import type { Worktree } from './workspace-list-types'

export function webHostScreenHostState(identity: HostScreenIdentity): HostScreenHostState {
  return {
    // Why: the page remounts this screen on every session return, so without the in-memory
    // cache the complete list is thrown away and rebuilt from a spinner each time.
    cachedWorkspaces(hostId) {
      return getCachedWorktrees(hostId) as Worktree[] | null
    },
    cacheWorkspaces(hostId, workspaces) {
      setCachedWorktrees(hostId, [...workspaces])
    },
    cacheRepositories() {},
    async loadPinnedWorkspaceIds() {
      return new Set()
    },
    async savePinnedWorkspaceIds() {},
    async loadIdentity() {
      return identity
    },
    async recordConnected() {}
  }
}
