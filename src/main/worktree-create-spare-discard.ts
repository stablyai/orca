import { whenLocalWorktreeCreatesSettle } from './git/local-worktree-create-activity'
import { discardPreparedWorktree } from './git/worktree-create-preparation'
import { releaseOwnedSpareId } from './git/worktree-create-spare-ids'
import type { GitWorktreeExecOptions } from './git/worktree-operation-options'

export type SpareToDiscard = {
  id: string
  repoPath: string
  path: string
  options: GitWorktreeExecOptions
}

let pendingDiscards = 0
let settled: Promise<void> = Promise.resolve()

export function hasPendingSpareDiscards(): boolean {
  return pendingDiscards > 0
}

/**
 * Removes a spare as background work: after local creates settle, at background priority, never on
 * a path anything awaits. One attempt; a spare it cannot remove stays locked with this process's
 * pid, so the next launch's sweep reclaims it from a dead owner.
 */
export function scheduleSpareDiscard(spare: SpareToDiscard): void {
  pendingDiscards += 1
  const discard = (async () => {
    try {
      await whenLocalWorktreeCreatesSettle()
      await discardPreparedWorktree(spare.repoPath, spare.path, {
        ...spare.options,
        signal: undefined,
        admissionTier: 'background'
      })
      releaseOwnedSpareId(spare.id)
    } catch (error) {
      console.warn(`[worktree-create] could not discard spare checkout ${spare.path}`, error)
    } finally {
      pendingDiscards -= 1
    }
  })()
  settled = Promise.all([settled, discard]).then(() => {})
}

export function _whenSpareDiscardsSettledForTests(): Promise<void> {
  return settled
}
