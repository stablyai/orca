/**
 * Worktree management and commit operations for the relay git handler.
 *
 * Why: extracted from git-handler-ops.ts to keep all relay files under
 * the oxlint max-lines (300) limit.
 */
import * as path from 'path'
import type { GitExec } from './git-handler-ops'

// ─── Worktree management ─────────────────────────────────────────────

export async function addWorktreeOp(git: GitExec, params: Record<string, unknown>): Promise<void> {
  const repoPath = params.repoPath as string
  const branchName = params.branchName as string
  const targetDir = params.targetDir as string
  const base = params.base as string | undefined
  const track = params.track as boolean | undefined

  // Why: a branchName starting with '-' would be interpreted as a git flag,
  // potentially changing the command's semantics (e.g. "--detach").
  if (branchName.startsWith('-') || (base && base.startsWith('-'))) {
    throw new Error('Branch name and base ref must not start with "-"')
  }

  const args = ['worktree', 'add']
  if (track) {
    args.push('--track')
  }
  args.push('-b', branchName, targetDir)
  if (base) {
    args.push(base)
  }

  await git(args, repoPath)
}

export async function removeWorktreeOp(
  git: GitExec,
  params: Record<string, unknown>
): Promise<void> {
  const worktreePath = params.worktreePath as string
  const force = params.force as boolean | undefined

  let repoPath = worktreePath
  try {
    const { stdout } = await git(['rev-parse', '--git-common-dir'], worktreePath)
    const commonDir = stdout.trim()
    if (commonDir && commonDir !== '.git') {
      repoPath = path.resolve(worktreePath, commonDir, '..')
    }
  } catch {
    // fall through with worktreePath as repo
  }

  const args = ['worktree', 'remove']
  if (force) {
    args.push('--force')
  }
  args.push(worktreePath)
  await git(args, repoPath)
  await git(['worktree', 'prune'], repoPath)
}

// ─── Commit ──────────────────────────────────────────────────────────

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
