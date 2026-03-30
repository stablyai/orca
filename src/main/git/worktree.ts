import { execFile, execFileSync } from 'child_process'
import { promisify } from 'util'
import type { GitWorktreeInfo } from '../../shared/types'

const execFileAsync = promisify(execFile)

/**
 * Parse the porcelain output of `git worktree list --porcelain`.
 */
export function parseWorktreeList(output: string): GitWorktreeInfo[] {
  const worktrees: GitWorktreeInfo[] = []
  // [Fix]: Use /\r?\n\r?\n/ to handle both LF and CRLF (\r\n) line endings,
  // which are common when running git on Windows.
  const blocks = output.trim().split(/\r?\n\r?\n/)

  for (const block of blocks) {
    if (!block.trim()) {
      continue
    }

    // [Fix]: Use /\r?\n/ to handle both LF and CRLF (\r\n) line endings.
    const lines = block.trim().split(/\r?\n/)
    let path = ''
    let head = ''
    let branch = ''
    let isBare = false

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        path = line.slice('worktree '.length)
      } else if (line.startsWith('HEAD ')) {
        head = line.slice('HEAD '.length)
      } else if (line.startsWith('branch ')) {
        branch = line.slice('branch '.length)
      } else if (line === 'bare') {
        isBare = true
      }
    }

    if (path) {
      worktrees.push({ path, head, branch, isBare })
    }
  }

  return worktrees
}

/**
 * List all worktrees for a git repo at the given path.
 */
export async function listWorktrees(repoPath: string): Promise<GitWorktreeInfo[]> {
  try {
    const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoPath,
      encoding: 'utf-8'
    })
    return parseWorktreeList(stdout)
  } catch {
    return []
  }
}

/**
 * Create a new worktree.
 * @param repoPath - Path to the main repo (or bare repo)
 * @param worktreePath - Absolute path where the worktree will be created
 * @param branch - Branch name for the new worktree
 * @param baseBranch - Optional base branch to create from (defaults to HEAD)
 */
export function addWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
  baseBranch?: string
): void {
  const args = ['worktree', 'add', '-b', branch, worktreePath]
  if (baseBranch) {
    args.push(baseBranch)
  }
  execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe']
  })
}

/**
 * Remove a worktree.
 */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  force = false
): Promise<void> {
  const args = ['worktree', 'remove', worktreePath]
  if (force) {
    args.push('--force')
  }
  await execFileAsync('git', args, {
    cwd: repoPath,
    encoding: 'utf-8'
  })
}
