import { expect, it, vi } from 'vitest'
import type { Worktree } from '../../../shared/worktree/types'
import type { WorktreeLineage } from '../../../shared/worktree/lineage-types'
import { createWorkspaceCleanupReleasedWorkerLookup } from './workspace-cleanup-orchestration-workers'
const workers = vi.hoisted(
  () =>
    new Map([
      ['child-a', { released: true, workerStartedAt: 1000 }],
      ['child-b', { released: true, workerStartedAt: 1000 }]
    ])
)
vi.mock('../../runtime/orchestration/db/worker-dispatch/worker-created-worktrees', () => ({
  listWorkerCreatedWorktrees: () => workers
}))
function row(
  id: string,
  instanceId: string,
  branch: string,
  hostId?: 'local' | 'ssh:other'
): Worktree {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: lineage resolution reads only identity, host, branch and creation fields.
  return { id, instanceId, branch, createdAt: 1, hostId } as Worktree
}
it('resolves multiple released children through host/incarnation-safe parents and rejects ambiguous twins', () => {
  const lineage = (id: string): WorktreeLineage => ({
    worktreeId: id,
    worktreeInstanceId: `${id}-instance`,
    parentWorktreeId: 'parent',
    parentWorktreeInstanceId: 'parent-instance',
    origin: 'cli',
    capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
    createdAt: 1
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lookup reads the provided lineage and mocked external worker database.
  const store = { getWorktreeLineage: lineage } as never
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the mocked database reader consumes this external boundary.
  const lookup = createWorkspaceCleanupReleasedWorkerLookup(store, () => ({}) as never)
  const first = row('child-a', 'child-a-instance', 'a', 'local')
  const second = row('child-b', 'child-b-instance', 'b', 'local')
  const parent = row('parent', 'parent-instance', 'refs/heads/coordinator', 'local')
  const remote = row('parent', 'parent-instance', 'refs/heads/wrong-host', 'ssh:other')
  const reused = row('parent', 'reused-instance', 'refs/heads/reused', 'local')
  const rows = [remote, reused, first, second, parent]
  expect(lookup(first, rows)).toEqual({ coordinatorBranch: 'coordinator' })
  expect(lookup(second, rows)).toEqual({ coordinatorBranch: 'coordinator' })
  expect(lookup({ ...first, hostId: undefined }, rows)).toEqual({ coordinatorBranch: null })
  expect(lookup(first, [first, reused, remote])).toEqual({ coordinatorBranch: null })
  expect(lookup(first, [first, parent, { ...parent, branch: 'ambiguous' }])).toEqual({
    coordinatorBranch: null
  })
  expect(lookup({ ...first, instanceId: 'replacement' }, rows)).toEqual({ coordinatorBranch: null })
})
