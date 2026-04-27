/**
 * Worktree management and commit operations for the relay git handler.
 *
 * Why: extracted from git-handler-ops.ts to keep all relay files under
 * the oxlint max-lines (300) limit.
 */
import * as path from 'path'
import type { GitExec } from './git-handler-ops'

// ─── Worktree management ─────────────────────────────────────────────

export async function addWorktreeOp(
  git: GitExec,
  validatePath: (p: string) => void,
  params: Record<string, unknown>
): Promise<void> {
  const repoPath = params.repoPath as string
  validatePath(repoPath)
  const branchName = params.branchName as string
  const targetDir = params.targetDir as string
  validatePath(targetDir)
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
  validatePath: (p: string) => void,
  params: Record<string, unknown>
): Promise<void> {
  const worktreePath = params.worktreePath as string
  validatePath(worktreePath)
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
  try {
    await git(['commit', '-m', message], worktreePath)
    return { success: true }
  } catch (error) {
    const stderr =
      typeof error === 'object' && error && 'stderr' in error && typeof error.stderr === 'string'
        ? error.stderr
        : error instanceof Error
          ? error.message
          : 'Commit failed'
    return { success: false, error: stderr }
  }
}
