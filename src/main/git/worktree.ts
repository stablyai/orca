import { posix, win32 } from 'path'
import type { GitWorktreeInfo } from '../../shared/types'
import { gitExecFileAsync, translateWslOutputPaths } from './runner'

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
    const { stdout } = await gitExecFileAsync(['worktree', 'list', '--porcelain'], {
      cwd: repoPath
    })
    // Why: when git runs inside WSL, worktree paths are Linux-native
    // (e.g. /home/user/repo). Translate them back to Windows UNC paths
    // so the rest of Orca can access them via Node fs APIs.
    const translated = translateWslOutputPaths(stdout, repoPath)
    return parseWorktreeList(translated)
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
export async function addWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
  baseBranch?: string,
  refreshLocalBaseRef = false
): Promise<void> {
  // Why: Some users want Orca-created worktrees to make plain commands like
  // `git diff main...HEAD` work out of the box, while others do not want
  // worktree creation to mutate their local main/master ref at all. Keep this
  // behavior behind an explicit setting so the default stays conservative.
  if (baseBranch && refreshLocalBaseRef) {
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
        await gitExecFileAsync(['merge-base', '--is-ancestor', localBranch, baseBranch], {
          cwd: repoPath
        })
        // Why: We need to find which worktree (if any) has localBranch checked
        // out, because moving the ref without updating that worktree's files would
        // leave it looking massively dirty. A sibling worktree we don't control is
        // just as vulnerable as the primary one.
        const { stdout: worktreeListOutput } = await gitExecFileAsync(
          ['worktree', 'list', '--porcelain'],
          { cwd: repoPath }
        )
        const worktrees = parseWorktreeList(translateWslOutputPaths(worktreeListOutput, repoPath))
        const fullRef = `refs/heads/${localBranch}`
        const ownerWorktree = worktrees.find((wt) => wt.branch === fullRef)

        if (ownerWorktree) {
          // Why: localBranch is checked out in a worktree. We can only safely
          // update if that worktree is clean, and we must use `reset --hard`
          // (run inside that worktree) so the files move with the ref.
          const { stdout: status } = await gitExecFileAsync(
            ['status', '--porcelain', '--untracked-files=no'],
            { cwd: ownerWorktree.path }
          )
          if (!status.trim()) {
            await gitExecFileAsync(['reset', '--hard', baseBranch], { cwd: ownerWorktree.path })
          }
        } else {
          // Why: localBranch is not checked out anywhere, so there is no working
          // tree to desync. `update-ref` is safe here.
          await gitExecFileAsync(['update-ref', fullRef, baseBranch], { cwd: repoPath })
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
  await gitExecFileAsync(args, { cwd: repoPath })
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
  await gitExecFileAsync(args, { cwd: repoPath })
  await gitExecFileAsync(['worktree', 'prune'], { cwd: repoPath })

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
    await gitExecFileAsync(['branch', '-D', branchName], { cwd: repoPath })
  } catch (error) {
    console.warn(
      `[git] Failed to delete local branch "${branchName}" after removing worktree`,
      error
    )
  }
}
