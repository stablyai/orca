import type { ExecutionHostId } from '../../shared/execution-host'
import type { RemoveWorktreeResult } from '../../shared/worktree/create-types'
import { finishAcceptedWorktreeRemoval } from '../worktree-background-removal'

export async function settleWorkspaceServerRemoval<T extends RemoveWorktreeResult>(
  removal: Promise<T>,
  args: {
    worktreeId: string
    hostId?: ExecutionHostId
    waitForBackgroundRemoval?: boolean
    release?: () => void
    onRemoved: () => void
  }
): Promise<T | Omit<T, 'removing'>> {
  let deferred = false
  try {
    const accepted = await removal
    if (!accepted.removing) {
      args.onRemoved()
    }
    const finished = finishAcceptedWorktreeRemoval(accepted, args.worktreeId, args.hostId)
    if (args.waitForBackgroundRemoval) {
      return await finished
    }
    // Acceptance is nonblocking, but new starts stay fenced until Git settles.
    deferred = true
    void finished.then(
      () => args.release?.(),
      () => args.release?.()
    )
    return accepted
  } finally {
    if (!deferred) {
      args.release?.()
    }
  }
}
