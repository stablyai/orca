import { stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { isHookRunUnsupportedError } from '../../shared/git-hook-run-capability'
import { windowsLongPathGitArgs } from '../../shared/windows-long-path-git-args'
import { toHostFilesystemPath } from '../host-tree-removal'
import { withLocalGitCapabilityCacheForExecution } from './git-capability-state'
import { withRepoRefMaintenancePaused } from './local-repo-ref-maintenance'
import { gitExecFileAsync } from './runner'
import { runWithGitReadCacheInvalidation } from './status'
import { invalidateWslLinkedWorktreeGitRouting } from './wsl-linked-worktree-git-routing'
import {
  gitExecOptions,
  resolveWorktreeAddTimeoutMs,
  WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS,
  type GitExecOptionsForWorktree,
  type GitWorktreeExecOptions
} from './worktree-operation-options'
import { translateWorktreePath } from './worktree-path-comparison'
import { bumpWorktreeScanGeneration } from './worktree-scan-cache'

/** Never stopped by a signal: a killed metadata command could strand a half-written registration. */
function gitMetadataOptions(
  cwd: string,
  options: GitWorktreeExecOptions,
  timeout = WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS
): GitExecOptionsForWorktree {
  return { ...gitExecOptions(cwd, { ...options, signal: undefined }), timeout }
}

/**
 * Builds a spare at `oid`: register without files, lock with Orca's reason, then check out. Locking
 * first means a checkout killed at any point leaves a spare only Orca's lock claims. Only the
 * checkout takes `signal`; resolves true only when it finished and the spare was not aborted.
 */
export async function prepareWorktreeCreateCheckout(
  repoPath: string,
  worktreePath: string,
  oid: string,
  lockReason: string,
  options: GitWorktreeExecOptions & {
    signal: AbortSignal
    /** Stops before the checkout without killing anything. */
    isCancelled?: () => boolean
    onRegistered?: () => void
  }
): Promise<boolean> {
  const { signal, isCancelled, onRegistered } = options
  // Checked before every step: a spare stopped at any point starts nothing more.
  const stopped = (): boolean => signal.aborted || Boolean(isCancelled?.())
  const metadata = gitMetadataOptions(repoPath, options, resolveWorktreeAddTimeoutMs())
  try {
    return await withRepoRefMaintenancePaused('worktree-prepare', () =>
      runWithGitReadCacheInvalidation(async () => {
        if (stopped()) {
          return false
        }
        await gitExecFileAsync(
          [
            ...windowsLongPathGitArgs(repoPath),
            'worktree',
            'add',
            '--detach',
            '--no-checkout',
            worktreePath,
            oid
          ],
          metadata
        )
        onRegistered?.()
        // The add just wrote the marker; drop any pre-create route before later commands route.
        invalidateWslLinkedWorktreeGitRouting(worktreePath)
        if (stopped()) {
          return false
        }
        await gitExecFileAsync(
          [
            ...windowsLongPathGitArgs(repoPath),
            'worktree',
            'lock',
            '--reason',
            lockReason,
            worktreePath
          ],
          metadata
        )
        if (stopped()) {
          return false
        }
        // Why reset: it materializes files without running the user's post-checkout hook early.
        // `--no-recurse-submodules`, as `worktree add` checks out: submodule.recurse must not apply.
        await gitExecFileAsync(
          [
            ...windowsLongPathGitArgs(worktreePath),
            'reset',
            '--hard',
            '--no-recurse-submodules',
            oid
          ],
          { ...gitExecOptions(worktreePath, options), timeout: resolveWorktreeAddTimeoutMs() }
        )
        return !signal.aborted
      })
    )
  } finally {
    bumpWorktreeScanGeneration(repoPath)
  }
}

/** Removes a spare, locked or not (Git 2.25 removes a locked worktree with the doubled --force). */
export async function discardPreparedWorktree(
  repoPath: string,
  worktreePath: string,
  options: GitWorktreeExecOptions = {}
): Promise<void> {
  try {
    await runWithGitReadCacheInvalidation(() =>
      gitExecFileAsync(
        [
          ...windowsLongPathGitArgs(repoPath),
          'worktree',
          'remove',
          '--force',
          '--force',
          worktreePath
        ],
        gitMetadataOptions(repoPath, options, options.timeout)
      )
    )
  } finally {
    invalidateWslLinkedWorktreeGitRouting(worktreePath)
    bumpWorktreeScanGeneration(repoPath)
  }
}

export async function unlockPreparedWorktree(
  repoPath: string,
  worktreePath: string,
  options: GitWorktreeExecOptions = {}
): Promise<void> {
  try {
    await runWithGitReadCacheInvalidation(() =>
      gitExecFileAsync(
        [...windowsLongPathGitArgs(repoPath), 'worktree', 'unlock', worktreePath],
        gitMetadataOptions(repoPath, options)
      )
    )
  } finally {
    bumpWorktreeScanGeneration(repoPath)
  }
}

/** `git hook run` (Git 2.36+) runs a hook with the exact arguments a plain create passes. */
export function supportsHookRun(
  repoPath: string,
  options: GitWorktreeExecOptions
): Promise<boolean> {
  return withLocalGitCapabilityCacheForExecution(
    { cwd: repoPath, wslDistro: options.wslDistro },
    (capabilities) =>
      capabilities.runWithFallback(
        'hook-run',
        async () => {
          // A hook name Git never defines, so the probe runs nothing.
          await gitExecFileAsync(
            ['hook', 'run', '--ignore-missing', 'orca-capability-probe'],
            gitExecOptions(repoPath, options)
          )
          return true
        },
        async () => false,
        isHookRunUnsupportedError
      )
  )
}

async function isRunnableHookFile(path: string): Promise<boolean> {
  try {
    const hook = await stat(toHostFilesystemPath(path))
    // Windows has no executable bit; Git for Windows runs any regular file there.
    return hook.isFile() && (process.platform === 'win32' || (hook.mode & 0o111) !== 0)
  } catch {
    return false
  }
}

/**
 * Whether a spare's handover can give `post-checkout` the arguments a plain create gives it: always
 * with `git hook run`, and on older Git only when no hook would run. `--git-path` honors
 * `core.hooksPath` (checked on Git 2.25.5 and 2.50.1); a relative one resolves against the repo.
 */
export async function checkSparePostCheckoutHook(
  repoPath: string,
  options: GitWorktreeExecOptions
): Promise<{ honorable: boolean; hookRun: boolean; hooksPath?: string }> {
  if (await supportsHookRun(repoPath, options)) {
    // Resolved in the repo, as a plain add resolves it: a relative core.hooksPath (husky's
    // gitignored `.husky/_`) names a directory only the main checkout has. `--path-format` is 2.31+.
    const { stdout } = await gitExecFileAsync(
      ['rev-parse', '--path-format=absolute', '--git-path', 'hooks'],
      gitExecOptions(repoPath, options)
    )
    return { honorable: true, hookRun: true, hooksPath: stdout.trim() }
  }
  const { stdout } = await gitExecFileAsync(
    ['rev-parse', '--git-path', 'hooks/post-checkout'],
    gitExecOptions(repoPath, options)
  )
  const hookPath = stdout.trim()
  const pathOps = isWindowsAbsolutePathLike(repoPath) ? win32 : posix
  const resolved = posix.isAbsolute(hookPath)
    ? translateWorktreePath(hookPath, repoPath, options)
    : pathOps.resolve(repoPath, hookPath)
  return { honorable: !(await isRunnableHookFile(resolved)), hookRun: false }
}
