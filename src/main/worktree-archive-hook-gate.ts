import type { Repo } from '../shared/repo-types'
import { getEffectiveHooks } from './hooks'
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

/**
 * The runtime's SSH removal path cannot run an archive hook at all (see #18563, which adds it).
 * Until it can, a removal that asked for hooks has to refuse rather than delete: deleting would
 * repeat exactly the bug this gate exists to stop, and reporting success would make
 * `worktree.archive-failure-blocking.v1` a lie in the one case the reporter asked it to cover.
 *
 * Modelled as `unverifiable` because that is what it is — the hook's outcome was never observed —
 * so it reuses the same typed error, the same `--allow-failed-archive-hook` waiver, and the same
 * desktop "Delete Anyway" affordance as any other unobserved hook.
 *
 * Returns the skipped-hook warning when hooks were not requested, matching the local path.
 */
export function gateRemovalWhereArchiveHookCannotRun(args: {
  repo: Repo
  worktreePath: string
  runHooks: boolean
}): string | undefined {
  if (!getEffectiveHooks(args.repo)?.scripts.archive) {
    return undefined
  }
  if (!args.runHooks) {
    const warning = `orca.yaml archive hook skipped for ${args.worktreePath}; pass --run-hooks to run it.`
    console.warn(`[hooks] ${warning}`)
    return warning
  }
  throw new WorktreeArchiveHookFailedError({
    worktreePath: args.worktreePath,
    outcome: 'unverifiable',
    output:
      'This host cannot run an archive hook for an SSH-hosted worktree, so the hook never ran. Remove it from the desktop app, which does run it, or retry without --run-hooks to delete without archiving.'
  })
}
