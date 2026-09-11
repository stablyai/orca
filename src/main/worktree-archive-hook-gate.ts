import {
  WorktreeArchiveHookFailedError,
  classifyArchiveHookFailure,
  formatArchiveHookFailure,
  type ArchiveHookOverride,
  type ArchiveHookRunResult
} from '../shared/worktree/archive-hook-removal-gate'

/**
 * The archive-hook precondition for a destructive worktree removal (#19334). Call it while the
 * checkout, its registration, its agents and its ownership evidence are all still intact: on a
 * failure it throws, and no caller may stop a PTY, deregister, or delete before it has returned.
 *
 * Returns the override record when the failure was explicitly waived, `undefined` on success.
 */
export function gateWorktreeRemovalOnArchiveHook(args: {
  worktreePath: string
  result: ArchiveHookRunResult
  allowFailure: boolean
}): ArchiveHookOverride | undefined {
  if (args.result.success) {
    return undefined
  }
  const failure = classifyArchiveHookFailure(args.worktreePath, args.result)
  if (!args.allowFailure) {
    console.error(`[hooks] ${formatArchiveHookFailure(failure)}`)
    throw new WorktreeArchiveHookFailedError(failure)
  }
  console.warn(
    `[hooks] archive hook failure overridden for ${args.worktreePath}; deleting anyway:`,
    args.result.output
  )
  return { ...failure, overridden: true }
}
