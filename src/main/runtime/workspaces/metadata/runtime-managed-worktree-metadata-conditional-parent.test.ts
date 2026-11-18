import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { testState, createStore, makeRepo } from '../../../persistence/persistence-test-harness'
import type { Store } from '../../../persistence/loading-store/store'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import { updateRuntimeManagedWorktreeMetadata } from './runtime-managed-worktree-metadata'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn().mockReturnValue({})
}))

const WORKTREE_ID = 'repo-1::/w/fix'

function underFolder(store: Store, folderId: string): void {
  store.setFolderParentLineage(hostWorktreeTarget({ id: WORKTREE_ID, hostId: 'local' }), {
    childWorkspaceKey: `worktree:${WORKTREE_ID}`,
    childInstanceId: 'inst-1',
    parentWorkspaceKey: `folder:${folderId}`,
    parentInstanceId: folderId,
    origin: 'manual',
    capture: { source: 'manual-action', confidence: 'explicit' },
    createdAt: 1
  })
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the write reads only id, repoId, hostId and instanceId of the resolved row.
const RESOLVED = {
  id: WORKTREE_ID,
  repoId: 'repo-1',
  hostId: 'local',
  instanceId: 'inst-1'
} as never

function unlink(store: Store, ifParentWorkspace: string) {
  return updateRuntimeManagedWorktreeMetadata({
    selector: `id:${WORKTREE_ID}`,
    updates: { lineage: { noParent: true, ifParentWorkspace } },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real persisted store; RuntimeStore is the subset of it the runtime reads.
    store: store as unknown as RuntimeStore,
    ports: {
      resolveWorktree: async () => RESOLVED,
      resolveParent: async () => {
        throw new Error('unused')
      },
      validateParent: () => {},
      invalidateResolved: () => {},
      invalidateScan: () => {},
      notifyChanged: () => {},
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the caller only awaits the shown row.
      showWorktree: async () => ({ id: WORKTREE_ID }) as never
    }
  })
}

describe('a conditional parent write (ifParentWorkspace)', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-conditional-parent-'))
  })
  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('refuses when the owner moved the workspace since (A→B hand-over, then to C), leaving C', async () => {
    const store = createStore()
    store.addRepo(makeRepo({ id: 'repo-1', path: '/w/repo' }))
    underFolder(store, 'C')

    await expect(unlink(store, 'folder:B')).rejects.toThrow('lineage_parent_changed')
    expect(store.getWorkspaceLineage(`worktree:${WORKTREE_ID}`)?.parentWorkspaceKey).toBe(
      'folder:C'
    )
  })

  it('writes while the workspace is still where the caller left it', async () => {
    const store = createStore()
    store.addRepo(makeRepo({ id: 'repo-1', path: '/w/repo' }))
    underFolder(store, 'B')

    await unlink(store, 'folder:B')
    expect(store.getWorkspaceLineage(`worktree:${WORKTREE_ID}`)).toBeUndefined()
  })
})
