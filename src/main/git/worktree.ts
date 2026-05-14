import { stat } from 'fs/promises'
import { join, posix, win32 } from 'path'
import type { GitWorktreeInfo } from '../../shared/types'
import { gitExecFileAsync, translateWslOutputPaths } from './runner'
import { resolveGitDir } from './status'

type SparseWorktreeCreateError = Error & {
  cleanupFailed?: boolean
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

function getErrorText(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const parts: string[] = []
    if ('message' in error && typeof error.message === 'string') {
      parts.push(error.message)
    }
    if ('stderr' in error && typeof error.stderr === 'string') {
      parts.push(error.stderr)
    }
    return parts.join('\n')
  }
  return String(error)
}

function isNotGitRepositoryError(error: unknown): boolean {
  return /not a git repository/i.test(getErrorText(error))
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
  const blocks = output
    .trim()
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim().split(/\r?\n/))

  for (const lines of blocks) {
    if (lines.length === 0) {
      continue
    }

    let path = ''
    let head = ''
    let branch = ''
    let isBare = false
    let isSparse = false

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        path = line.slice('worktree '.length)
      } else if (line.startsWith('HEAD ')) {
        head = line.slice('HEAD '.length)
      } else if (line.startsWith('branch ')) {
        branch = line.slice('branch '.length)
      } else if (line === 'bare') {
        isBare = true
      } else if (line === 'sparse') {
        isSparse = true
      }
    }

    if (path) {
      // `git worktree list` always emits the main working tree first.
      worktrees.push({
        path,
        head,
        branch,
        isBare,
        ...(isSparse ? { isSparse } : {}),
        isMainWorktree: worktrees.length === 0
      })
    }
  }

  return worktrees
}

/**
 * List all worktrees for a git repo at the given path.
 */
export async function listWorktrees(repoPath: string): Promise<GitWorktreeInfo[]> {
  try {
    // Why: do not pass `-z` here. `-z` requires Git ≥ 2.36; older Git rejects
    // it, listWorktrees returns [], and every create flow throws "Worktree
    // created but not found in listing" (issue #1453).
    const { stdout } = await gitExecFileAsync(['worktree', 'list', '--porcelain'], {
      cwd: repoPath
    })
    const worktrees = parseWorktreeList(stdout).map((worktree) => {
      const translatedPath = translateWorktreePath(worktree.path, repoPath)
      return translatedPath === worktree.path ? worktree : { ...worktree, path: translatedPath }
    })
    return Promise.all(
      worktrees.map(async (worktree) => {
        if (worktree.isBare || worktree.isSparse) {
          return worktree
        }
        const isSparse = await detectSparseCheckout(worktree.path)
        return isSparse ? { ...worktree, isSparse } : worktree
      })
    )
  } catch (err) {
    if (getErrorCode(err) === 'ENOENT') {
      try {
        await stat(repoPath)
      } catch (statErr) {
        if (getErrorCode(statErr) === 'ENOENT') {
          console.warn(`[git/worktree] repo path missing; skipping worktree list: ${repoPath}`)
          return []
        }
      }
    }
    if (isNotGitRepositoryError(err)) {
      return []
    }
    // Why: a silent catch turned issue #1453's underlying
    // "git: unknown switch -z" into the opaque "not found in listing" toast.
    // Surface the cause so future regressions show up immediately.
    console.warn(`[git/worktree] listWorktrees failed for ${repoPath}:`, err)
    return []
  }
}

/**
 * Create a new worktree.
 * @param repoPath - Path to the main repo (or bare repo)
 * @param worktreePath - Absolute path where the worktree will be created
 * @param branch - Branch name for the new worktree
 * @param baseBranch - Optional base branch to create from (defaults to HEAD)
 * @remarks Side effect: passes `--no-track` and may write `push.autoSetupRemote=true`
 * to the repo's shared config (best-effort, warn-only on failure; preserves any
 * user-set value at any scope). See body comment below for the full rationale.
 */
export async function addWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
  baseBranch?: string,
  refreshLocalBaseRef = false,
  noCheckout = false
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

  const args = ['worktree', 'add']
  if (noCheckout) {
    args.push('--no-checkout')
  }
  // Why: --no-track keeps the new branch from inheriting the base ref's
  // upstream, so `git status` doesn't report "behind by N" against the base
  // pre-publish and tools/agents don't misread an unpublished branch as
  // out-of-sync. First push sets the upstream — see push.autoSetupRemote
  // below for the terminal ergonomics.
  args.push('--no-track', '-b', branch, worktreePath)
  if (baseBranch) {
    args.push(baseBranch)
  }
  await gitExecFileAsync(args, { cwd: repoPath })

  // SSH parity: src/relay/git-handler.ts addWorktree mirrors this exact
  // probe-and-write state machine. If you change the logic here, update
  // the relay handler in lockstep so local and SSH paths stay aligned.
  //
  // Why: with --no-track there is no upstream until first push. Setting
  // push.autoSetupRemote=true makes a plain `git push` from the terminal
  // create origin/<branch> and set it as upstream automatically — matching
  // user expectations from modern git without requiring `-u`. Note that
  // `--local` on a linked worktree writes to the shared common-dir config,
  // so this affects the whole repo, not just this worktree. That is
  // intentional and acceptable: the value is benign and idempotent, and
  // every Orca-created worktree wants the same default. True per-worktree
  // scope would require enabling extensions.worktreeConfig=true repo-wide,
  // which is a larger change we deliberately avoid.
  //
  // Notes on the design:
  // - push.autoSetupRemote is honored by git >= 2.37; older clients ignore
  //   the value, so `git push` falls back to the pre-2.37 "no upstream"
  //   error and the user runs `git push -u` once.
  // - Failures here are warn-only: config writes are best-effort and a
  //   missing write degrades to the same fallback as old git.
  // - The write is skipped when any value is already set (local, global,
  //   or system) so a deliberate user `false` is preserved.
  // - Not rolled back on creation failure: addSparseWorktree's catch path
  //   removes the worktree but does not unset this config. That is consistent
  //   with the "benign and idempotent" rationale above — every Orca-created
  //   worktree wants this default, and a future creation will silently re-set
  //   it via the existing-value check anyway.
  try {
    // Why: `--get` (not `--local --get`) so a value set at any scope
    // (local/global/system) counts as "user already chose" and we don't
    // overwrite it.
    let alreadySet = false
    try {
      await gitExecFileAsync(['config', '--get', 'push.autoSetupRemote'], {
        cwd: worktreePath
      })
      alreadySet = true
    } catch (readError) {
      // Why: `git config --get` exits 1 only when the key is unset at every
      // scope. Any other exit code means a real read failure (corrupt config,
      // locked file, parse error) — surface that via the outer catch instead
      // of silently overwriting whatever value the user actually has.
      const code = (readError as { code?: unknown })?.code
      if (code !== 1) {
        throw readError
      }
    }
    if (!alreadySet) {
      await gitExecFileAsync(['config', '--local', 'push.autoSetupRemote', 'true'], {
        cwd: worktreePath
      })
    }
  } catch (error) {
    console.warn(`addWorktree: failed to set push.autoSetupRemote for ${worktreePath}`, error)
  }
}

export async function addSparseWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
  directories: string[],
  baseBranch?: string,
  refreshLocalBaseRef = false
): Promise<void> {
  let created = false
  try {
    await addWorktree(repoPath, worktreePath, branch, baseBranch, refreshLocalBaseRef, true)
    created = true
    await gitExecFileAsync(['sparse-checkout', 'init', '--cone'], { cwd: worktreePath })
    await gitExecFileAsync(['sparse-checkout', 'set', '--', ...directories], { cwd: worktreePath })
    await gitExecFileAsync(['checkout', branch], { cwd: worktreePath })
  } catch (error) {
    const wrapped: SparseWorktreeCreateError =
      error instanceof Error ? (error as SparseWorktreeCreateError) : new Error(String(error))
    if (created) {
      try {
        await removeWorktree(repoPath, worktreePath, true)
      } catch {
        wrapped.cleanupFailed = true
        // Why: the user needs to know that manual cleanup may be required —
        // otherwise a half-created worktree silently lingers on disk.
        wrapped.message = `${wrapped.message} (cleanup also failed — the partially created worktree at "${worktreePath}" may need manual removal)`
      }
    }
    throw wrapped
  }
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

function translateWorktreePath(worktreePath: string, repoPath: string): string {
  const prefix = 'worktree '
  const translated = translateWslOutputPaths(`${prefix}${worktreePath}`, repoPath)
  return translated.startsWith(prefix) ? translated.slice(prefix.length) : worktreePath
}

async function detectSparseCheckout(worktreePath: string): Promise<boolean> {
  // Why: `listWorktrees` runs on every 3-second git-status poll and on every
  // worktree refresh, so this probe fires N times per poll for N worktrees.
  // The previous `git sparse-checkout list` subprocess made that N*poll extra
  // git processes, which regressed app responsiveness on machines with many
  // worktrees (see PR #1131 revert in #1290). A single fs.stat on the
  // per-worktree sparse-checkout config file is ~two orders of magnitude
  // cheaper and has the same truthiness semantics: Git writes this file when
  // sparse checkout is enabled for the worktree and does not write it
  // otherwise.
  //
  // Why per-worktree gitdir and not `<worktreePath>/.git/info/sparse-checkout`:
  // linked worktrees have a `.git` file that points at
  // `<repo>/.git/worktrees/<name>`, and that is where Git stores the
  // worktree-local sparse-checkout config. `core.sparseCheckout` itself is
  // shared across all worktrees, so the presence of the config file is the
  // correct per-worktree signal.
  try {
    const gitDir = await resolveGitDir(worktreePath)
    const stats = await stat(join(gitDir, 'info', 'sparse-checkout'))
    return stats.isFile() && stats.size > 0
  } catch {
    return false
  }
}
