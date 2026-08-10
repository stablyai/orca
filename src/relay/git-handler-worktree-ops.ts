import * as path from 'node:path'
import {
  findGitCryptStateDirectory,
  shareGitCryptStateWithWorktree
} from '../shared/git-crypt-worktree-state'
import {
  clampGitWorktreeCreateTimeoutMs,
  createGitWorktreeCleanupDeadline,
  createGitWorktreeDeadline,
  remainingGitWorktreeCreateMs,
  type GitWorktreeCreateDeadline
} from '../shared/git-worktree-create-timeout'
import {
  resolveGitWorktreeCreateLockIdentity,
  withGitWorktreeCreateLock
} from '../shared/git-worktree-create-lock'
import { resolveWorktreeAddBaseRef } from '../shared/worktree-base-ref'
import type { GitExec } from './git-handler-ops'
export { removeWorktreeOp } from './git-handler-worktree-remove'
export { readRelayWorktreeList } from './git-handler-worktree-list'

async function rollbackRelayWorktreeCreate(
  git: GitExec,
  repoPath: string,
  targetDir: string,
  branchName: string,
  ownership: { target: boolean; branch: boolean },
  error: unknown
): Promise<never> {
  const wrapped = error instanceof Error ? error : new Error(String(error))
  if (!ownership.target && !ownership.branch) {
    throw wrapped
  }
  let worktreeRemoved = !ownership.target
  try {
    if (ownership.target) {
      try {
        await git(['worktree', 'remove', '--force', targetDir], repoPath)
      } catch {
        // Why: add may fail after creating only a branch or a stale registration; prune and verify below.
      }
      await git(['worktree', 'prune'], repoPath)
      const { stdout } = await git(['worktree', 'list', '--porcelain'], repoPath)
      worktreeRemoved = !stdout
        .split(/\n(?=worktree )/)
        .map((entry) => entry.match(/^worktree (.+)$/m)?.[1])
        .some((candidate) => candidate && areRelayWorktreePathsEqual(candidate, targetDir))
    }
    if (ownership.branch) {
      try {
        await git(['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], repoPath)
        await git(['branch', '-D', '--', branchName], repoPath)
      } catch (branchError) {
        if ((branchError as { code?: unknown })?.code !== 1) {
          if (worktreeRemoved) {
            wrapped.message = `${wrapped.message} (cleanup also failed — the worktree was removed, but branch "${branchName}" was preserved)`
            throw wrapped
          }
          throw branchError
        }
      }
    }
  } catch (cleanupError) {
    if (cleanupError !== wrapped || !worktreeRemoved) {
      wrapped.message = `${wrapped.message} (cleanup also failed — the partially created worktree at "${targetDir}" may need manual removal)`
    }
  }
  throw wrapped
}

async function captureRelayWorktreeCreateOwnership(
  git: GitExec,
  repoPath: string,
  targetDir: string,
  branchName: string
): Promise<{ target: boolean; branch: boolean }> {
  const { stdout } = await git(['worktree', 'list', '--porcelain'], repoPath)
  const targetExists = stdout
    .split(/\n(?=worktree )/)
    .map((entry) => entry.match(/^worktree (.+)$/m)?.[1])
    .some((candidate) => candidate && areRelayWorktreePathsEqual(candidate, targetDir))
  let branchExists = true
  try {
    await git(['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], repoPath)
  } catch (error) {
    if ((error as { code?: unknown })?.code !== 1) {
      throw error
    }
    branchExists = false
  }
  return { target: !targetExists, branch: !branchExists }
}

async function persistRelayWorktreeCreationBase(
  git: GitExec,
  targetDir: string,
  branchName: string,
  effectiveBase: string
): Promise<void> {
  const configKey = `branch.${branchName}.base`
  try {
    await git(['config', '--local', '--replace-all', configKey, effectiveBase], targetDir)
  } catch (error) {
    console.warn(`relay addWorktree: failed to set ${configKey} for ${targetDir}`, error)
    try {
      // Why: SSH worktree creation shares branch config by name; clear stale
      // metadata if replacing an old same-name base fails.
      await git(['config', '--local', '--unset-all', configKey], targetDir)
    } catch (unsetError) {
      console.warn(
        `relay addWorktree: failed to unset stale ${configKey} for ${targetDir}`,
        unsetError
      )
    }
  }
}

export async function addWorktreeOp(
  git: GitExec,
  params: Record<string, unknown>,
  request: { signal?: AbortSignal } = {}
): Promise<void> {
  const repoPath = params.repoPath as string
  const branchName = params.branchName as string
  let targetDir = params.targetDir as string
  const base = params.base as string | undefined
  const checkoutExistingBranch = params.checkoutExistingBranch === true
  const noCheckout = params.noCheckout === true

  // Why: a branchName starting with '-' would be interpreted as a git flag,
  // potentially changing the command's semantics (e.g. "--detach").
  if (branchName.startsWith('-') || (base && base.startsWith('-'))) {
    throw new Error('Branch name and base ref must not start with "-"')
  }

  const timeoutMs = clampGitWorktreeCreateTimeoutMs(params.timeoutMs)
  const deadline = createGitWorktreeDeadline(timeoutMs, request.signal)
  const runWithDeadline =
    (operationDeadline: GitWorktreeCreateDeadline): GitExec =>
    (args, cwd, options) =>
      git(args, cwd, {
        ...options,
        signal: operationDeadline.signal,
        timeout: remainingGitWorktreeCreateMs(operationDeadline, `Git ${args.join(' ')}`)
      })
  const runWorktreeGit = runWithDeadline(deadline)
  const identity = await resolveGitWorktreeCreateLockIdentity(
    runWorktreeGit,
    repoPath,
    targetDir,
    deadline
  )
  targetDir = identity.target

  return withGitWorktreeCreateLock(identity, branchName, deadline, async () => {
    // Why: mirror local --no-track semantics so create has the same push UX over SSH.
    const effectiveBase =
      base && !checkoutExistingBranch
        ? await resolveWorktreeAddBaseRef(base, async (qualifiedRef) => {
            try {
              await runWorktreeGit(
                ['rev-parse', '--verify', '--quiet', `${qualifiedRef}^{commit}`],
                repoPath
              )
              return true
            } catch {
              return false
            }
          })
        : undefined

    // Why: git-crypt resolves state through each worktree's private Git dir;
    // defer checkout until that dir references the repository-wide state.
    const gitCryptDir = await findGitCryptStateDirectory(
      runWorktreeGit,
      repoPath,
      undefined,
      deadline,
      identity.repository
    )
    const deferCheckoutForGitCrypt = gitCryptDir !== null && !noCheckout

    const args = ['worktree', 'add']
    if (noCheckout || deferCheckoutForGitCrypt) {
      args.push('--no-checkout')
    }
    if (checkoutExistingBranch) {
      args.push(targetDir, branchName)
    } else {
      args.push('--no-track', '-b', branchName, targetDir)
    }
    if (effectiveBase) {
      args.push(effectiveBase)
    }

    if (gitCryptDir) {
      const ownership = await captureRelayWorktreeCreateOwnership(
        runWorktreeGit,
        repoPath,
        targetDir,
        branchName
      )
      try {
        // Why: rollback ownership begins before Git can leave a branch or registration behind.
        await runWorktreeGit(args, repoPath)
        await shareGitCryptStateWithWorktree(
          runWorktreeGit,
          gitCryptDir,
          targetDir,
          undefined,
          deadline
        )
        if (deferCheckoutForGitCrypt) {
          await runWorktreeGit(['checkout'], targetDir)
        }
      } catch (error) {
        const cleanupGit = runWithDeadline(createGitWorktreeCleanupDeadline())
        return rollbackRelayWorktreeCreate(
          cleanupGit,
          repoPath,
          targetDir,
          branchName,
          {
            target: ownership.target,
            branch: ownership.branch && !checkoutExistingBranch
          },
          error
        )
      }
    } else {
      await runWorktreeGit(args, repoPath)
    }

    if (checkoutExistingBranch) {
      return
    }

    if (effectiveBase) {
      await persistRelayWorktreeCreationBase(runWorktreeGit, targetDir, branchName, effectiveBase)
    }

    // Why: best-effort write so a deliberate user value (any scope) is
    // preserved and a real read failure is not silently overwritten. Final
    // catch is warn-only — if the remote host's git is <2.37 the value is
    // ignored at push time and the user falls back to `git push -u` once.
    // (Note: it is the SSH host's git that matters here, not the client's.)
    // Mirrors local addWorktree exactly.
    try {
      let alreadySet = false
      try {
        await runWorktreeGit(['config', '--get', 'push.autoSetupRemote'], targetDir)
        alreadySet = true
      } catch (readError) {
        // Why: `git config --get` exits 1 only when the key is unset at every
        // scope. Any other code is a real read failure (corrupt config,
        // locked file) — surface it via the outer catch instead of falling
        // through to overwrite the user's actual value.
        const code = (readError as { code?: unknown })?.code
        if (code !== 1) {
          throw readError
        }
      }
      if (!alreadySet) {
        await runWorktreeGit(['config', '--local', 'push.autoSetupRemote', 'true'], targetDir)
      }
    } catch (error) {
      console.warn(`relay addWorktree: failed to set push.autoSetupRemote for ${targetDir}`, error)
    }
  })
}

function isPosixAbsolutePath(value: string): boolean {
  return value.startsWith('/')
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

function normalizeRelayWorktreePathForCompare(value: string): string {
  if (isPosixAbsolutePath(value)) {
    return path.posix.normalize(path.posix.resolve(value))
  }
  if (isWindowsAbsolutePath(value)) {
    return path.win32.normalize(path.win32.resolve(value))
  }
  return path.normalize(path.resolve(value))
}

export function areRelayWorktreePathsEqual(leftPath: string, rightPath: string): boolean {
  const left = normalizeRelayWorktreePathForCompare(leftPath)
  const right = normalizeRelayWorktreePathForCompare(rightPath)
  const compareCaseInsensitive = isWindowsAbsolutePath(leftPath) && isWindowsAbsolutePath(rightPath)
  return compareCaseInsensitive ? left.toLowerCase() === right.toLowerCase() : left === right
}

export async function worktreeIsCleanOp(
  git: GitExec,
  params: Record<string, unknown>
): Promise<{ clean: boolean; stdout?: string }> {
  const worktreePath = params.worktreePath as string
  const includeUntracked = params.includeUntracked !== false
  const { stdout } = await git(
    ['status', '--porcelain', includeUntracked ? '--untracked-files=all' : '--untracked-files=no'],
    worktreePath
  )
  const clean = !stdout.trim()
  return { clean, stdout: clean ? undefined : stdout }
}

export async function commitChangesRelay(
  git: GitExec,
  worktreePath: string,
  message: string
): Promise<{ success: boolean; error?: string }> {
  // Why: defense-in-depth. The IPC handler at src/main/ipc/filesystem.ts validates
  // the message, but a relay caller (future automation, or an SSH client connecting
  // to the relay directly) could bypass that path. Reject empty/whitespace messages
  // here so we surface a clear error instead of git's opaque failure.
  if (typeof message !== 'string' || message.trim().length === 0) {
    return { success: false, error: 'Commit message is required' }
  }

  try {
    await git(['commit', '-m', message], worktreePath)
    return { success: true }
  } catch (error) {
    // Why: surface whichever channel carries the useful message. Pre-commit/GPG
    // hook failures write to stderr; "nothing to commit, working tree clean"
    // writes to stdout. Try stderr first, fall back to stdout, then error.message.
    // Mirrors commitChanges in src/main/git/status.ts — keep the two paths in sync.
    const readStringField = (field: string): string | null => {
      if (typeof error === 'object' && error && field in error) {
        const v = (error as Record<string, unknown>)[field]
        if (typeof v === 'string' && v.length > 0) {
          return v
        }
      }
      return null
    }
    const errorMessage =
      readStringField('stderr') ??
      readStringField('stdout') ??
      (error instanceof Error ? error.message : 'Commit failed')
    return { success: false, error: errorMessage }
  }
}
