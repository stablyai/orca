import type { HostScreenHostState } from './host-screen-host-state'

export const defaultHostScreenHostState: HostScreenHostState = {
  cachedWorkspaces() {
    return null
  },
  cacheWorkspaces() {},
  cacheRepositories() {},
  async loadPinnedWorkspaceIds() {
    return new Set()
  },
  async savePinnedWorkspaceIds() {},
  async loadIdentity() {
    return null
  },
  async recordConnected() {}
}
