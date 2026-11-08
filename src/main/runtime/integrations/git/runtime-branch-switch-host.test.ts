import { expect, it, vi } from 'vitest'
import { createBranchSwitchHost } from './runtime-branch-switch-host'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'

vi.mock('../../../persistence/host-qualified-worktree-meta', () => ({
  worktreeRowTarget: (_store: unknown, worktree: unknown) => worktree
}))

it('keeps automatic naming after commit checkout while preserving branch-link clearing', () => {
  const meta = { linkedPR: 42, branchNameIsUserChosen: false }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the switch callback only reads and updates this metadata fixture.
  const store = {
    getWorktreeMetaForHost: () => meta,
    setWorktreeMeta: (_target: unknown, updates: Partial<WorktreeMeta>) =>
      Object.assign(meta, updates)
  } as unknown as RuntimeStore
  const host = createBranchSwitchHost({
    getStore: () => store,
    readAgentRows: () => [],
    readAgentPaneRows: () => [],
    ptys: () => [],
    paneOf: () => ({ tabId: null, paneKey: null }),
    terminalHandlesOf: () => [],
    hasSyncedTab: () => false,
    savedTabIds: () => [],
    probeProcess: async () => null,
    notifyBranchChanged: () => {},
    folderWorkspacePaths: () => new Map()
  })
  const worktree = { id: 'r::/repo', hostId: 'local' as const, repoId: 'r' }
  host.recordBranchSwitched(worktree, true)
  expect(meta).toMatchObject({ linkedPR: null, branchNameIsUserChosen: false })
  host.recordBranchSwitched(worktree)
  expect(meta.branchNameIsUserChosen).toBe(true)
})
