import { describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { WorktreeRemovalRecord } from '../../../workspaces/removal/worktree-removal-records'
import { retryFailedWorktreeRemoval } from '../../../workspaces/removal/worktree-background-removal'
import { interruptedLocalWorktreeRemovalJob } from '../../../runtime/workspaces/removal/runtime-interrupted-local-worktree-removal'
import { removeWorktreeMetadataAndTransientState } from './worktree-removal-ownership'
import type { RuntimeWorktreeLifecycleEvent } from '../../../runtime/workspaces/lifecycle/worktree-lifecycle-event'
import type { WorktreeIpcContext } from '../worktree-ipc-context'
import { retryFailedLocalWorktreeRemoval } from './retry-failed-local-worktree-removal'

vi.mock('../../../workspaces/removal/worktree-background-removal', () => ({
  retryFailedWorktreeRemoval: vi.fn()
}))
vi.mock('../../../runtime/workspaces/removal/runtime-interrupted-local-worktree-removal', () => ({
  interruptedLocalWorktreeRemovalJob: vi.fn()
}))
vi.mock('./worktree-removal-ownership', () => ({
  removeWorktreeMetadataAndTransientState: vi.fn(),
  stopPtysForDestructiveWorktreeRemoval: vi.fn()
}))
vi.mock('./registered-worktree-roots-scoped-invalidation', () => ({
  invalidateAuthorizedRootsCacheForRepo: vi.fn()
}))

const WORKTREE_ID = 'repo-1::/src/feature'
const record: WorktreeRemovalRecord = {
  worktreeId: WORKTREE_ID,
  repoId: 'repo-1',
  repoPath: '/src/app',
  worktreePath: '/src/feature',
  branch: 'feature',
  head: '',
  deleteBranch: false,
  force: false,
  requestedAt: 1
}

describe('retrying a failed desktop worktree removal', () => {
  it('announces the identity its purge dropped', async () => {
    const rows: Record<string, { instanceId: string; hostId: ExecutionHostId }> = {
      [WORKTREE_ID]: { instanceId: 'i1', hostId: 'local' }
    }
    vi.mocked(removeWorktreeMetadataAndTransientState).mockImplementation((_owners, id) => {
      delete rows[id]
    })
    let host: Parameters<typeof interruptedLocalWorktreeRemovalJob>[1] | undefined
    vi.mocked(interruptedLocalWorktreeRemovalJob).mockImplementation((_record, jobHost) => {
      host = jobHost
      return { run: vi.fn(), publish: vi.fn() }
    })
    vi.mocked(retryFailedWorktreeRemoval).mockImplementation((_id, _hostId, jobFor) => {
      jobFor(record)
      return Promise.resolve({})
    })
    const emitted: RuntimeWorktreeLifecycleEvent[] = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the retry reads only the store, runtime and lifecycle sink supplied here.
    const context = {
      store: {
        getWorktreeMeta: (id: string) => rows[id],
        getWorktreeMetaForHost: (id: string, hostId: ExecutionHostId) =>
          rows[id]?.hostId === hostId ? rows[id] : undefined
      },
      runtime: { clearOptimisticReconcileToken: vi.fn(), publishWorktreeRemovalChange: vi.fn() },
      options: {
        onWorktreeLifecycle: (event: RuntimeWorktreeLifecycleEvent) => emitted.push(event)
      }
    } as unknown as WorktreeIpcContext
    await retryFailedLocalWorktreeRemoval(context, { worktreeId: WORKTREE_ID }, 'local')
    await host?.purge(record)
    host?.onRemoved(record)
    expect(rows[WORKTREE_ID]).toBeUndefined()
    expect(emitted).toEqual([
      {
        kind: 'removed',
        worktreeId: WORKTREE_ID,
        path: '/src/feature',
        identityKey: 'wt2:local:i1',
        hostId: 'local'
      }
    ])
  })
})
