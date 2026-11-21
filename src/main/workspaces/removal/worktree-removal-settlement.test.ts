import { afterEach, expect, it } from 'vitest'
import type { WorktreeRemovalRecord } from './worktree-removal-records'
import {
  addPendingRemoval,
  finishAcceptedWorktreeRemoval,
  settlementsByWorktreeId,
  withAcceptedCompletion
} from './worktree-removal-settlement'
import { pendingWorktreeRemovals } from './worktree-removal-table'

const record: WorktreeRemovalRecord = {
  worktreeId: 'repo::/w',
  repoId: 'repo',
  repoPath: '/repo',
  worktreePath: '/w',
  branch: 'feature',
  head: 'abc',
  deleteBranch: false,
  force: false,
  requestedAt: 1
}

afterEach(() => {
  pendingWorktreeRemovals.clear()
  settlementsByWorktreeId.clear()
})

it('reports a removal that failed before the caller looked it up, not a removed workspace', async () => {
  const settlement = addPendingRemoval(record)
  settlement.accept()
  const accepted = withAcceptedCompletion({ removing: true }, settlement.result)
  // The background job fails fast: it clears its pending entry, then rejects.
  pendingWorktreeRemovals.delete(record.worktreeId)
  settlementsByWorktreeId.delete(record.worktreeId)
  settlement.reject(new Error('refused before deleting'))

  await expect(finishAcceptedWorktreeRemoval(accepted, record.worktreeId)).rejects.toThrow(
    'refused before deleting'
  )
})

it('still follows the pending entry for a reply that carries no completion', async () => {
  const settlement = addPendingRemoval(record)
  const finished = finishAcceptedWorktreeRemoval({ removing: true }, record.worktreeId)
  settlement.resolve({})
  await expect(finished).resolves.toEqual({})
})
