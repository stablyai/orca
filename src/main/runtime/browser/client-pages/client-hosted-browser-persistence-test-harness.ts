import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { orderTerminalRowsByTabGroups } from '../../../../shared/workspace-layout/terminal-topology/terminal-row-order'
const WT = 'repo-1::/tmp/worktree-a'

const storeBase = {
  getRepo: () => ({
    id: 'repo-1',
    path: '/tmp/repo',
    displayName: 'repo',
    badgeColor: 'blue',
    addedAt: 1
  }),
  getRepos: () => [storeBase.getRepo()],
  addRepo: () => {},
  updateRepo: () => {
    throw new Error('unused fixture write')
  },
  getAllWorktreeMeta: () => ({}),
  getWorktreeMeta: () => undefined,
  getGitHubCache: () => ({ pr: {}, issue: {} }),
  setWorktreeMeta: () => {
    throw new Error('unused fixture write')
  },
  removeWorktreeMeta: () => {},
  getRetiredWorktreeNameRegistry: () => ({ exhaustedTiers: 0, names: [] }),
  addRetiredWorktreeName: () => {},
  mergeRetiredWorktreeNames: () => false,
  getSettings: () => ({
    workspaceDir: '/tmp/workspaces',
    nestWorkspaces: false,
    refreshLocalBaseRefOnWorktreeCreate: false,
    branchPrefix: 'none',
    branchPrefixCustom: ''
  })
}

export function createProfile(worktreeCount = 0) {
  const work = { writes: 0, normalizedWorktrees: 0 }
  let measuringWrite = false
  const tabsByWorktree: WorkspaceSessionState['tabsByWorktree'] = {}
  for (let index = 0; index < worktreeCount; index += 1) {
    const id = index === 0 ? WT : `repo-1::/tmp/worktree-${index}`
    const rows = [
      {
        id: `terminal-${index}`,
        ptyId: null,
        worktreeId: id,
        title: 'Terminal',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 1
      }
    ]
    Object.defineProperty(tabsByWorktree, id, {
      enumerable: true,
      configurable: true,
      get: () => {
        if (measuringWrite) {
          work.normalizedWorktrees += 1
        }
        return rows
      }
    })
  }
  const state: { session: WorkspaceSessionState } = {
    session: {
      activeRepoId: 'repo-1',
      activeWorktreeId: WT,
      activeTabId: null,
      tabsByWorktree,
      terminalLayoutsByTabId: {}
    } satisfies WorkspaceSessionState
  }
  return {
    work,
    get session() {
      return state.session
    },
    store: {
      ...storeBase,
      getWorkspaceSession: () => state.session,
      setWorkspaceSession: (next: WorkspaceSessionState) => {
        work.writes += 1
        measuringWrite = true
        try {
          state.session = orderTerminalRowsByTabGroups(next)
        } finally {
          measuringWrite = false
        }
      }
    }
  }
}
