import { execFile, execFileSync } from 'child_process'
import { posix, win32 } from 'path'
import type { GitWorktreeInfo } from '../../shared/types'

function runGit(
  repoPath: string,
  args: string[]
): Promise<{
  stdout: string
  stderr: string
}> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: repoPath, encoding: 'utf-8' }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

function normalizeLocalBranchRef(branch: string): string {
  return branch.replace(/^refs\/heads\//, '')
}

function areWorktreePathsEqual(
  leftPath: string,
  rightPath: string,
  platform = process.platform
): boolean {
  if (platform === 'win32' || looksLikeWindowsPath(leftPath) || looksLikeWindowsPath(rightPath)) {
    return (
      win32.normalize(win32.resolve(leftPath)).toLowerCase() ===
      win32.normalize(win32.resolve(rightPath)).toLowerCase()
    )
  }
  return posix.normalize(posix.resolve(leftPath)) === posix.normalize(posix.resolve(rightPath))
}

function looksLikeWindowsPath(pathValue: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(pathValue) || pathValue.startsWith('\\\\')
}

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
      // `git worktree list` always emits the main working tree first.
      worktrees.push({ path, head, branch, isBare, isMainWorktree: worktrees.length === 0 })
    }
  }

  return worktrees
}

/**
 * List all worktrees for a git repo at the given path.
 */
export async function listWorktrees(repoPath: string): Promise<GitWorktreeInfo[]> {
  try {
    const { stdout } = await runGit(repoPath, ['worktree', 'list', '--porcelain'])
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
  // Why: Fast-forward the local branch (e.g. master) to match its remote tracking
  // branch (e.g. origin/master) so that `git diff master...HEAD` works correctly
  // inside worktrees. Callers are responsible for fetching the remote before
  // calling addWorktree(), so we do not fetch here.
  if (baseBranch) {
    // Why: We split on '/' instead of matching a hardcoded 'origin/' prefix because
    // callers may pass arbitrary remotes (e.g. 'upstream/main'), not just 'origin'.
    const slashIndex = baseBranch.indexOf('/')
    if (slashIndex > 0) {
      const localBranch = baseBranch.slice(slashIndex + 1)
      try {
        // Why: We only fast-forward the local branch pointer. A force-move (`branch -f`)
        // would silently destroy unpushed local commits if the branch has diverged from
        // remote. `merge-base --is-ancestor` returns exit 0 when localBranch is an
        // ancestor of baseBranch — i.e. the update is a safe fast-forward.
        execFileSync('git', ['merge-base', '--is-ancestor', localBranch, baseBranch], {
          cwd: repoPath,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe']
        })
        // Why: If the worktree that has localBranch checked out has uncommitted
        // changes, moving the ref with update-ref would shift the baseline commit
        // and muddle their diffs. Only update if the working tree is clean.
        const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
          cwd: repoPath,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe']
        })
        if (!status.trim()) {
          // Safe fast-forward: local branch is behind (or equal to) the remote ref.
          // Why: `git branch -f` refuses to update a branch checked out in another
          // worktree. `git update-ref` writes the ref directly, bypassing that
          // restriction. This is the common case — master/main is almost always
          // checked out in the main worktree.
          execFileSync('git', ['update-ref', `refs/heads/${localBranch}`, baseBranch], {
            cwd: repoPath,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe']
          })
        }
      } catch {
        // merge-base fails if the local branch doesn't exist or has diverged;
        // update-ref fails on locked/corrupted refs or filesystem errors.
        // Both cases are non-fatal — skip the update silently.
      }
    }
  }

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
  const worktreesBeforeRemoval = await listWorktrees(repoPath)
  const removedWorktree = worktreesBeforeRemoval.find((worktree) =>
    areWorktreePathsEqual(worktree.path, worktreePath)
  )
  const branchName = normalizeLocalBranchRef(removedWorktree?.branch ?? '')

  const args = ['worktree', 'remove']
  if (force) {
    args.push('--force')
  }
  args.push(worktreePath)
  await runGit(repoPath, args)
  await runGit(repoPath, ['worktree', 'prune'])

  if (!branchName) {
    return
  }

  // Why: `git worktree list` can still include stale sibling records until
  // `git worktree prune` runs. Re-list after prune so branch cleanup only skips
  // when a still-live worktree actually keeps that branch checked out.
  const worktreesAfterPrune = await listWorktrees(repoPath)
  const branchStillInUse = worktreesAfterPrune.some(
    (worktree) => normalizeLocalBranchRef(worktree.branch) === branchName
  )
  if (branchStillInUse) {
    return
  }

  try {
    // Why: `git worktree remove` only detaches the filesystem entry. Orca also
    // drops the now-unused local branch here so delete-worktree does not leave
    // behind orphaned feature branches unless another worktree still points at it.
    await runGit(repoPath, ['branch', '-D', branchName])
  } catch (error) {
    console.warn(
      `[git] Failed to delete local branch "${branchName}" after removing worktree`,
      error
    )
  }
}
