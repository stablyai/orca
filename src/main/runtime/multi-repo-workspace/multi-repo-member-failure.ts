import {
  MULTI_REPO_MEMBER_FAILURE_MESSAGE_MAX_LENGTH,
  type MultiRepoMember
} from '../../../shared/multi-repo-workspace'
import { WorktreeCreateCollisionError } from '../../../shared/new-workspace/worktree-create-collision'
import { PlacedWorktreePathOccupiedError } from './placed-worktree-path-occupied-error'

const REPO_UNAVAILABLE_MESSAGES = new Set([
  'repo_not_found',
  'selector_not_found',
  'runtime_unavailable'
])

export function classifyMultiRepoMemberFailure(
  error: unknown
): NonNullable<MultiRepoMember['failure']> {
  const message = error instanceof Error ? error.message : String(error)
  const code =
    error instanceof PlacedWorktreePathOccupiedError
      ? 'path_occupied'
      : error instanceof WorktreeCreateCollisionError
        ? 'branch_conflict'
        : REPO_UNAVAILABLE_MESSAGES.has(message)
          ? 'repo_unavailable'
          : error instanceof Error
            ? 'git_failed'
            : 'unknown'
  return {
    code,
    message: message.slice(0, MULTI_REPO_MEMBER_FAILURE_MESSAGE_MAX_LENGTH),
    at: Date.now()
  }
}
