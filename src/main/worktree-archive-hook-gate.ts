import {
  WorktreeArchiveHookFailedError,
  classifyArchiveHookFailure,
  formatArchiveHookFailure,
  type ArchiveHookOverride,
  type ArchiveHookRunResult
} from '../shared/worktree/archive-hook-removal-gate'

/** Run before PTY teardown, deregistration or deletion, while the archive hook still has its checkout. */
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
