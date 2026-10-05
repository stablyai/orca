import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Store } from '../../../persistence/loading-store/store'
import { removeWorktreeMetadataAndTransientState } from './worktree-removal-ownership'

const { disposeForWorktree } = vi.hoisted(() => ({ disposeForWorktree: vi.fn() }))

vi.mock('../../pty', () => ({
  getSshPtyProvider: vi.fn(),
  getLocalPtyProvider: vi.fn(),
  clearProviderPtyState: vi.fn()
}))
vi.mock('../../../runtime/worktree-teardown', () => ({ killAllProcessesForWorktree: vi.fn() }))
vi.mock('../../../lsp/lsp-session-registry', () => ({
  getLspSessionManager: () => ({ disposeForWorktree })
}))
vi.mock('../../../worktree-removal-repo-owner', () => ({
  hasWorktreeRemovalRepoOwnerOnOtherHost: () => false
}))
vi.mock('../../../ports/advertised-url-watcher', () => ({
  advertisedUrlWatcher: { forgetWorktree: vi.fn() }
}))
vi.mock('../../../localhost-worktree-label-proxy', () => ({
  localhostWorktreeLabelProxy: { unregisterWorktree: vi.fn() }
}))
vi.mock('../../../terminal-history-deletion', () => ({ deleteWorktreeHistoryDir: vi.fn() }))
vi.mock('../../../github/pr-refresh-coordinator', () => ({
  pruneWorktreePRRefreshAliases: vi.fn()
}))
vi.mock('../../../workspace-cleanup-removal-snapshot-prune', () => ({
  recordWorkspaceCleanupRemovalSnapshotPrune: vi.fn()
}))
vi.mock('../../../workspace-cleanup-scan-snapshot', () => ({
  pruneWorkspaceCleanupScanSnapshot: vi.fn()
}))
vi.mock('../../../workspace-space-analysis-snapshot', () => ({
  pruneWorkspaceSpaceAnalysisSnapshot: vi.fn()
}))

function fakeStore(): Store {
  const store: Pick<
    Store,
    'getWorktreeMeta' | 'removeWorktreeMeta' | 'getProfileStorageDirectory'
  > = {
    getWorktreeMeta: () => undefined,
    removeWorktreeMeta: vi.fn(),
    getProfileStorageDirectory: () => '/profile'
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the function under test only calls the three methods provided.
  return store as Store
}

describe('removeWorktreeMetadataAndTransientState', () => {
  beforeEach(() => disposeForWorktree.mockClear())

  it.each<[string, ExecutionHostId | undefined]>([
    ['no host', undefined],
    ['the local host', 'local']
  ])('disposes local LSP sessions for a removal on %s', (_label, hostId) => {
    removeWorktreeMetadataAndTransientState(fakeStore(), 'repo::/wt', hostId)
    expect(disposeForWorktree).toHaveBeenCalledWith('repo::/wt')
  })

  it('keeps local LSP sessions when a remote host removes a same-id worktree', () => {
    removeWorktreeMetadataAndTransientState(fakeStore(), 'repo::/wt', 'ssh:box')
    expect(disposeForWorktree).not.toHaveBeenCalled()
  })
})
