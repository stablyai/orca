import { GitCommandTimeoutError } from '../../../shared/git/commands/git-command-timeout'
import { WorktreeCreateExactNameTakenError } from '../../../shared/new-workspace/worktree-create-collision'
import type { StrictBranchConflictKind } from '../../git/refs/resolution/repo-branch-conflict'

/** Exact mode has one candidate; anything that would move a create to the next suffix refuses instead. */
export function exactNameTakenError(name: string): WorktreeCreateExactNameTakenError {
  return new WorktreeCreateExactNameTakenError(
    `"${name}" is already taken on this host. Nothing was created.`
  )
}

/** An inconclusive probe refuses exact mode rather than counting the name as free. */
export function exactNameBranchConflict(
  kind: StrictBranchConflictKind | null,
  branchName: string
): 'local' | 'remote' | null {
  if (kind === 'unknown') {
    throw new WorktreeCreateExactNameTakenError(
      `Orca couldn't confirm branch "${branchName}" is free. Nothing was created.`
    )
  }
  return kind
}

function gitFailureText(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return ''
  }
  const stderr = 'stderr' in error ? error.stderr : undefined
  const message = 'message' in error ? error.message : undefined
  return [stderr, message].filter((part) => typeof part === 'string').join('\n')
}

/**
 * `worktree add -b` refuses an existing branch before writing anything, so that failure is the exact-name
 * refusal once the path is confirmed absent. Git creates the branch before it checks the path, so a path
 * collision (like a timeout or localized Git output) stays an operational failure.
 */
export async function exactNameLateCollision(
  error: unknown,
  args: { branchName: string; worktreePath: string; pathExists: (path: string) => Promise<boolean> }
): Promise<unknown> {
  if (
    error instanceof GitCommandTimeoutError ||
    !gitFailureText(error).includes(`a branch named '${args.branchName}' already exists`)
  ) {
    return error
  }
  try {
    if (await args.pathExists(args.worktreePath)) {
      return error
    }
  } catch {
    return error
  }
  return new WorktreeCreateExactNameTakenError(
    `Branch "${args.branchName}" appeared before Orca could create it. Nothing was created.`
  )
}
