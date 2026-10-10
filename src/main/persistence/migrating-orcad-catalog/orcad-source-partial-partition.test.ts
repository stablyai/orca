import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { Repo } from '../../../shared/repo-types'
import { collectOrcadMigrationSourceDormantState } from './orcad-source-dormant-state'

const TARGET_ID = 'ssh-b4'
const WORKTREE = 'repo-1::/root/repo'
const REPO: Repo = {
  id: 'repo-1',
  path: '/root/repo',
  displayName: 'repo',
  badgeColor: '#737373',
  addedAt: 1,
  connectionId: TARGET_ID
}
const SOURCE = { sshTargetId: TARGET_ID, sshTargetGeneration: 2, targetLabel: 'B4' }
const CATALOG = { repositories: [REPO], projectGroups: [], folderWorkspaces: [] }

/** The real-host shape: renderer snapshots split per host leave out maps a host had no rows in. */
function partialPartitions() {
  const state = getDefaultPersistedState('/tmp/orcad-partial-partition')
  state.repos = [REPO]
  state.workspaceSession = {
    ...state.workspaceSession,
    defaultTerminalTabsAppliedByWorktreeId: { [WORKTREE]: true }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reproduces partitions persisted without required maps.
  const runtimePartition = {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    unifiedTabs: {},
    tabGroups: {}
  } as unknown as WorkspaceSessionState
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same, for the source host.
  const hostPartition = {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: { [WORKTREE]: [] },
    activeTabTypeByWorktree: { [WORKTREE]: 'terminal' },
    defaultTerminalTabsAppliedByWorktreeId: { [WORKTREE]: true },
    closedTerminalTabTombstonesByTabId: {
      'tab-closed': { worktreeId: WORKTREE, reason: 'user', closedAt: 1 }
    },
    terminalLayoutsByTabId: {}
  } as unknown as WorkspaceSessionState
  state.workspaceSessionsByHostId = {
    'runtime:env-1': runtimePartition,
    [`ssh:${TARGET_ID}`]: hostPartition
  }
  return state
}

describe('collecting dormant state from partially written session partitions', () => {
  it('neither throws on missing maps nor blocks on a marker both partitions agree on', () => {
    const inspection = collectOrcadMigrationSourceDormantState(partialPartitions(), SOURCE, CATALOG)
    expect(inspection.blockedCounts['workspace-session']).toBe(0)
    expect(inspection.payload.workspaceSession?.defaultTerminalTabsAppliedByWorktreeId).toEqual({
      [WORKTREE]: true
    })
  })

  it('still blocks when two partitions disagree about the same worktree', () => {
    const state = partialPartitions()
    state.workspaceSession.activeTabTypeByWorktree = { [WORKTREE]: 'editor' }
    expect(
      collectOrcadMigrationSourceDormantState(state, SOURCE, CATALOG).blockedCounts[
        'workspace-session'
      ]
    ).toBe(1)
  })
})
