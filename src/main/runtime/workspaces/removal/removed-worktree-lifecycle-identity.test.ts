import { describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { WorktreeRemovalRecord } from '../../../workspaces/removal/worktree-removal-records'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import { OrcaRuntimeWithResolveWorktreeRemovalTarget } from '../workspace-removal-target'
import type { RuntimeWorktreeLifecycleEvent } from '../lifecycle/worktree-lifecycle-event'

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

/** One local metadata row, which the purge drops before listeners hear `removed`. */
function metaRows() {
  const rows: Record<string, { instanceId: string; hostId: ExecutionHostId }> = {
    [WORKTREE_ID]: { instanceId: 'i1', hostId: 'local' }
  }
  const store = {
    getWorktreeMeta: (id: string) => rows[id],
    getWorktreeMetaForHost: (id: string, hostId: ExecutionHostId) =>
      rows[id]?.hostId === hostId ? rows[id] : undefined
  }
  return { rows, store }
}

abstract class RemovalJobProbe extends OrcaRuntimeWithResolveWorktreeRemovalTarget {
  jobHost(store: RuntimeStore) {
    return this.localRemovalJobHost(store)
  }
}

describe('worktree removal announces the identity the purge dropped', () => {
  it('in the runtime removal job', async () => {
    const { rows, store } = metaRows()
    const emitted: RuntimeWorktreeLifecycleEvent[] = []
    const probe: RemovalJobProbe = Object.assign(Object.create(RemovalJobProbe.prototype), {
      purgeRemovedWorktree: async (_store: unknown, worktreeId: string) => {
        delete rows[worktreeId]
      },
      emitWorktreeLifecycle: (event: RuntimeWorktreeLifecycleEvent) => emitted.push(event),
      publishWorktreeRemovalChange: vi.fn()
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the job host reads only the metadata accessors supplied here.
    const host = probe.jobHost(store as unknown as RuntimeStore)
    await host.purge(record)
    host.onRemoved(record)
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
