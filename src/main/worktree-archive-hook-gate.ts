import type { Repo } from '../shared/repo-types'
import { getArchiveHooksForRemoval } from './ipc/worktrees/removal/worktree-archive-hook'
import {
  WorktreeArchiveHookFailedError,
  formatArchiveHookOverride,
  type ArchiveHookFailure,
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
 * desktop "Delete Anyway" affordance as any other unobserved hook. Waiving it records the same
 * `archiveHookOverride` the other paths return, so a caller is told what it accepted.
 *
 * Returns the skipped-hook warning when hooks were not requested, matching the local path.
 *
 * Hooks are read through `getArchiveHooksForRemoval` rather than `getEffectiveHooks`: on an
 * SSH-hosted worktree `repo.path` names a path on the EXECUTION host, so a local read would miss
 * the committed `orca.yaml` this gate exists for, and could refuse on a coincidental local one.
 */
export async function gateRemovalWhereArchiveHookCannotRun(args: {
  repo: Repo
  /** The removal route's owner; `repo.connectionId` is null for an `ssh:`-only row. */
  connectionId: string | undefined
  worktreePath: string
  runHooks: boolean
  /** Explicit waiver. Without it the refusal below has no exit on this path. */
  allowFailedArchiveHook: boolean
}): Promise<{ warning?: string; override?: ArchiveHookOverride }> {
  const hooks = await getArchiveHooksForRemoval(args.repo, args.connectionId)
  if (!hooks?.scripts.archive) {
    return {}
  }
  if (!args.runHooks) {
    const warning = `orca.yaml archive hook skipped for ${args.worktreePath}; pass --run-hooks to run it.`
    console.warn(`[hooks] ${warning}`)
    return { warning }
  }
  const failure: ArchiveHookFailure = {
    worktreePath: args.worktreePath,
    outcome: 'unverifiable',
    output:
      'This host cannot run an archive hook for an SSH-hosted worktree, so the hook never ran. Remove it from the desktop app, which does run it, or delete anyway to accept that nothing was archived.'
  }
  if (!args.allowFailedArchiveHook) {
    throw new WorktreeArchiveHookFailedError(failure)
  }
  console.warn(`[hooks] ${formatArchiveHookOverride({ ...failure, overridden: true })}`)
  return { override: { ...failure, overridden: true } }
}
