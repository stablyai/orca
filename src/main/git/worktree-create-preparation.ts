import { windowsLongPathGitArgs } from '../../shared/windows-long-path-git-args'
import { resolveWorktreeAddBaseRef } from '../../shared/worktree/base-ref'
import type { AddWorktreeOptions, AddWorktreeResult, GitWorktreeExecOptions } from './worktree'
import {
  configurePushAutoSetupRemote,
  notifyPreparedWorktreeMutation,
  persistWorktreeCreationBase,
  resolveWorktreeAddBaseContext,
  resolveWorktreeAddTimeoutMs,
  WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS
} from './worktree'
import { hasWorktreeBaseCommitRef } from './worktree-base-ref-probe'
import { withRepoRefMaintenancePaused } from './local-repo-ref-maintenance'
import { gitExecFileAsync } from './runner'
import { runWithGitReadCacheInvalidation } from './status'
import { invalidateWslLinkedWorktreeGitRouting } from './wsl-linked-worktree-git-routing'

function gitExecOptions(
  cwd: string,
  options: GitWorktreeExecOptions
): { cwd: string; wslDistro?: string; signal?: AbortSignal; timeout?: number } {
  return {
    cwd,
    ...(options.wslDistro ? { wslDistro: options.wslDistro } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeout ? { timeout: options.timeout } : {})
  }
}

function gitCleanupOptions(
  cwd: string,
  options: GitWorktreeExecOptions
): { cwd: string; wslDistro?: string; timeout?: number } {
  // Why: cancellation must not strand a partially moved worktree; cleanup is bounded separately.
  return gitExecOptions(cwd, { ...options, signal: undefined })
}

async function performDiscardPreparedWorktree(
  repoPath: string,
  worktreePath: string,
  options: GitWorktreeExecOptions
): Promise<void> {
  const cleanupGitOptions = {
    ...gitCleanupOptions(repoPath, options),
    timeout: options.timeout ?? WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS
  }
  try {
    await gitExecFileAsync(
      [...windowsLongPathGitArgs(repoPath), 'worktree', 'unlock', worktreePath],
      cleanupGitOptions
    )
  } catch {
    // It may be unlocked already or only partially registered.
  }
  try {
    await gitExecFileAsync(
      [...windowsLongPathGitArgs(repoPath), 'worktree', 'remove', '--force', worktreePath],
      cleanupGitOptions
    )
  } finally {
    invalidateWslLinkedWorktreeGitRouting(worktreePath)
  }
}

export async function prepareWorktreeCreateCheckout(
  repoPath: string,
  worktreePath: string,
  baseBranch: string,
  lockReason: string,
  options: GitWorktreeExecOptions = {}
): Promise<void> {
  try {
    await withRepoRefMaintenancePaused('worktree-prepare', () =>
      runWithGitReadCacheInvalidation(async () => {
        const effectiveBase = await resolveWorktreeAddBaseRef(baseBranch, (qualifiedRef) =>
          hasWorktreeBaseCommitRef(repoPath, qualifiedRef, options)
        )
        try {
          await gitExecFileAsync(
            [
              ...windowsLongPathGitArgs(repoPath),
              'worktree',
              'add',
              '--detach',
              '--no-checkout',
              worktreePath,
              effectiveBase
            ],
            { ...gitExecOptions(repoPath, options), timeout: resolveWorktreeAddTimeoutMs() }
          )
          // The add just wrote the marker; drop any pre-create route before the reset routes Git.
          invalidateWslLinkedWorktreeGitRouting(worktreePath)
          // Why: reset materializes files without running user post-checkout hooks before submit.
          await gitExecFileAsync(
            [...windowsLongPathGitArgs(worktreePath), 'reset', '--hard', effectiveBase],
            { ...gitExecOptions(worktreePath, options), timeout: resolveWorktreeAddTimeoutMs() }
          )
          await gitExecFileAsync(
            [
              ...windowsLongPathGitArgs(repoPath),
              'worktree',
              'lock',
              '--reason',
              lockReason,
              worktreePath
            ],
            { ...gitExecOptions(repoPath, options), timeout: resolveWorktreeAddTimeoutMs() }
          )
        } catch (error) {
          await performDiscardPreparedWorktree(repoPath, worktreePath, options).catch(() => {})
          throw error
        }
      })
    )
  } finally {
    notifyPreparedWorktreeMutation(repoPath)
  }
}

export async function discardPreparedWorktree(
  repoPath: string,
  worktreePath: string,
  options: GitWorktreeExecOptions = {}
): Promise<void> {
  try {
    await runWithGitReadCacheInvalidation(() =>
      performDiscardPreparedWorktree(repoPath, worktreePath, options)
    )
  } finally {
    notifyPreparedWorktreeMutation(repoPath)
  }
}

export async function unlockPreparedWorktree(
  repoPath: string,
  worktreePath: string,
  options: GitWorktreeExecOptions = {}
): Promise<void> {
  const cleanupGitOptions = {
    ...gitCleanupOptions(repoPath, options),
    timeout: options.timeout ?? WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS
  }
  try {
    await runWithGitReadCacheInvalidation(() =>
      gitExecFileAsync(
        [...windowsLongPathGitArgs(repoPath), 'worktree', 'unlock', worktreePath],
        cleanupGitOptions
      )
    )
  } finally {
    notifyPreparedWorktreeMutation(repoPath)
  }
}

async function removeFailedFinalization(
  repoPath: string,
  cleanupPath: string,
  branch: string,
  moved: boolean,
  options: GitWorktreeExecOptions
): Promise<void> {
  let branchAttached = false
  if (moved) {
    try {
      const { stdout } = await gitExecFileAsync(
        ['symbolic-ref', '--short', 'HEAD'],
        gitCleanupOptions(cleanupPath, options)
      )
      branchAttached = stdout.trim() === branch
    } catch {
      // Detached or no longer readable.
    }
  }
  await performDiscardPreparedWorktree(repoPath, cleanupPath, options).catch(() => {})
  if (branchAttached) {
    await gitExecFileAsync(
      ['branch', '-D', '--', branch],
      gitCleanupOptions(repoPath, options)
    ).catch(() => {})
  }
}

export async function finalizePreparedWorktree(
  repoPath: string,
  preparedPath: string,
  worktreePath: string,
  branch: string,
  baseBranch: string,
  refreshLocalBaseRef = false,
  options: AddWorktreeOptions = {}
): Promise<AddWorktreeResult> {
  const finalizeGitOptions: AddWorktreeOptions = {
    ...options,
    timeout: options.timeout ?? resolveWorktreeAddTimeoutMs()
  }
  try {
    return await runWithGitReadCacheInvalidation(async () => {
      const baseContext = await resolveWorktreeAddBaseContext(
        repoPath,
        baseBranch,
        refreshLocalBaseRef,
        finalizeGitOptions
      )
      const [targetHeadResult, preparedHeadResult] = await Promise.all([
        gitExecFileAsync(
          ['rev-parse', '--verify', `${baseContext.effectiveBase}^{commit}`],
          gitExecOptions(repoPath, finalizeGitOptions)
        ),
        gitExecFileAsync(
          ['rev-parse', '--verify', 'HEAD'],
          gitExecOptions(preparedPath, finalizeGitOptions)
        )
      ])
      const { stdout: targetHeadOutput } = targetHeadResult
      const targetHead = targetHeadOutput.trim()
      const { stdout: preparedHeadOutput } = preparedHeadResult
      if (preparedHeadOutput.trim() !== targetHead) {
        await gitExecFileAsync(
          [...windowsLongPathGitArgs(preparedPath), 'reset', '--hard', targetHead],
          gitExecOptions(preparedPath, finalizeGitOptions)
        )
      }

      let moved = false
      try {
        try {
          // Why: `-f -f` moves the locked preparation while preserving its lock reason (Git >=2.25).
          await gitExecFileAsync(
            [
              ...windowsLongPathGitArgs(repoPath),
              'worktree',
              'move',
              '-f',
              '-f',
              preparedPath,
              worktreePath
            ],
            gitExecOptions(repoPath, finalizeGitOptions)
          )
          moved = true
        } finally {
          // The move rewrites both `.git` markers, and a failure can have rewritten one.
          invalidateWslLinkedWorktreeGitRouting(preparedPath)
          invalidateWslLinkedWorktreeGitRouting(worktreePath)
        }
        await gitExecFileAsync(
          [
            ...windowsLongPathGitArgs(worktreePath),
            'checkout',
            '--no-track',
            '-b',
            branch,
            targetHead
          ],
          gitExecOptions(worktreePath, finalizeGitOptions)
        )
        await persistWorktreeCreationBase(
          worktreePath,
          branch,
          baseContext.effectiveBase,
          finalizeGitOptions
        )
        await configurePushAutoSetupRemote(worktreePath, finalizeGitOptions)
        await gitExecFileAsync(
          [...windowsLongPathGitArgs(repoPath), 'worktree', 'unlock', worktreePath],
          gitExecOptions(repoPath, finalizeGitOptions)
        )
      } catch (error) {
        await removeFailedFinalization(
          repoPath,
          moved ? worktreePath : preparedPath,
          branch,
          moved,
          finalizeGitOptions
        )
        throw error
      }
      return {
        ...(baseContext.localBaseRefRefresh
          ? { localBaseRefRefresh: baseContext.localBaseRefRefresh }
          : {}),
        ...(baseContext.localBaseRefUpdateSuggestion
          ? { localBaseRefUpdateSuggestion: baseContext.localBaseRefUpdateSuggestion }
          : {})
      }
    })
  } finally {
    notifyPreparedWorktreeMutation(repoPath)
  }
}
