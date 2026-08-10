import type { GlobalSettings, Repo } from '../shared/types'
import type {
  WorktreeCreateTimeoutOverrides,
  WorktreeCreateTimeouts
} from '../shared/worktree-create-timeouts'
import { resolveWorktreeCreateTimeouts } from '../shared/worktree-create-timeouts'

export type WorktreeCreateStageDeadline = {
  remainingMs: () => number
}

export function createWorktreeCreateStageDeadline(
  timeoutMs: number,
  timeoutMessage: string
): WorktreeCreateStageDeadline {
  const deadlineAt = Date.now() + timeoutMs
  return {
    remainingMs: () => {
      const remaining = deadlineAt - Date.now()
      if (remaining <= 0) {
        throw new Error(timeoutMessage)
      }
      return remaining
    }
  }
}

export function getEffectiveWorktreeCreateTimeouts(
  repo: Pick<Repo, 'worktreeCreateTimeouts'>,
  settings: Pick<GlobalSettings, 'worktreeCreateTimeouts'>,
  request?: WorktreeCreateTimeoutOverrides
): WorktreeCreateTimeouts {
  return resolveWorktreeCreateTimeouts({
    global: settings.worktreeCreateTimeouts,
    repo: repo.worktreeCreateTimeouts,
    request
  })
}
