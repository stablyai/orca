/* eslint-disable max-lines -- Why: worktree operations (parse, list, add, remove, heal, exclude management) are tightly coupled and share private helpers like resolveGitCommonDir and areWorktreePathsEqual. Splitting them across files would force those helpers to become public API and create circular dependencies. */
import { dirname, posix, join as pathJoin, relative as pathRelative, win32 } from 'path'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { rm } from 'fs/promises'
import type { GitWorktreeInfo } from '../../shared/types'
import { gitExecFileAsync, gitExecFileSync, translateWslOutputPaths } from './runner'

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

// ─── Shared git-common-dir resolution ───────────────────────────────

/**
 * Resolve the shared git directory (`.git` for normal repos, the bare root
 * for bare repos) via `git rev-parse --git-common-dir`.
 *
 * Why: three callers (exclude helpers, admin-entry removal, healing) all need
 * the common dir. Centralising here avoids duplicating the Windows path check
 * — `git rev-parse` returns a platform-native path, so we must test both
 * `posix.isAbsolute` and `win32.isAbsolute` to avoid mangling Windows absolute
 * paths (e.g. `C:\repo\.git`) by joining them as if they were relative.
 */
/** @internal — exported for testing only */
export function resolveGitCommonDir(repoPath: string): string | null {
  try {
    const raw = gitExecFileSync(['rev-parse', '--git-common-dir'], { cwd: repoPath }).trim()
    if (posix.isAbsolute(raw) || win32.isAbsolute(raw)) {
      return raw
    }
    return pathJoin(repoPath, raw)
  } catch {
    return null
  }
}

// ─── .git/info/exclude helpers for nested worktrees ─────────────────

const ORCA_EXCLUDE_MARKER = '# orca-managed nested worktrees'

/**
 * Get the path to .git/info/exclude, resolving through the common git dir
 * so it works from both the primary worktree and linked worktrees.
 */
function getInfoExcludePath(repoPath: string): string {
  const commonDir = resolveGitCommonDir(repoPath)
  if (commonDir) {
    return pathJoin(commonDir, 'info', 'exclude')
  }
  return pathJoin(repoPath, '.git', 'info', 'exclude')
}

/**
 * Return the repo-root-relative exclude pattern for a nested worktree,
 * or null if the worktree is not inside the repo (i.e. not nested).
 */
/** @internal — exported for testing only */
export function nestedExcludePattern(repoPath: string, worktreePath: string): string | null {
  if (looksLikeWindowsPath(repoPath) || looksLikeWindowsPath(worktreePath)) {
    const rel = win32.relative(win32.resolve(repoPath), win32.resolve(worktreePath))
    if (!rel || rel.startsWith('..') || win32.isAbsolute(rel)) {
      return null
    }
    // Normalize to forward slashes for .gitignore syntax
    return `/${rel.replace(/\\/g, '/')}`
  }
  const rel = pathRelative(posix.resolve(repoPath), posix.resolve(worktreePath))
  if (!rel || rel.startsWith('..') || posix.isAbsolute(rel)) {
    return null
  }
  return `/${rel}`
}

/**
 * Add a nested worktree path to .git/info/exclude so that `git clean`,
 * `git status`, and other operations in the parent repo leave it alone.
 *
 * Why: nested worktrees (created when nestWorkspaces is true) live inside
 * the parent repo's working tree. From git's perspective these are untracked
 * directories. Without an exclude entry, `git clean -fd` will enter them
 * and delete non-gitignored files — including the `.git` linkage file,
 * which permanently orphans the worktree.
 */
/** @internal — exported for testing only */
export function addNestedWorktreeExclude(repoPath: string, worktreePath: string): void {
  const pattern = nestedExcludePattern(repoPath, worktreePath)
  if (!pattern) {
    return
  }

  const excludePath = getInfoExcludePath(repoPath)
  try {
    const dir = dirname(excludePath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    const content = existsSync(excludePath) ? readFileSync(excludePath, 'utf-8') : ''
    // Already present — skip
    if (content.split(/\r?\n/).some((line) => line.trim() === pattern)) {
      return
    }

    // Why: preserve the existing file's line endings so Windows repos do not
    // see `.git/info/exclude` churn just because Orca appended one pattern.
    const eol = content.includes('\r\n') ? '\r\n' : '\n'
    const hasMarker = content.includes(ORCA_EXCLUDE_MARKER)
    const suffix = hasMarker
      ? `${pattern}${eol}`
      : `${eol}${ORCA_EXCLUDE_MARKER}${eol}${pattern}${eol}`
    writeFileSync(excludePath, content.replace(/\r?\n?$/, eol) + suffix)
  } catch {
    // Best-effort — exclude entry is a convenience, not a hard requirement.
  }
}

/**
 * Remove a nested worktree path from .git/info/exclude.
 *
 * Why: removal is scoped to lines inside the Orca marker block to avoid
 * accidentally deleting a user-authored line that happens to match the
 * pattern. If the last Orca pattern is removed, the marker itself is
 * also cleaned up so the file does not accumulate stale headers.
 */
/** @internal — exported for testing only */
export function removeNestedWorktreeExclude(repoPath: string, worktreePath: string): void {
  const pattern = nestedExcludePattern(repoPath, worktreePath)
  if (!pattern) {
    return
  }

  const excludePath = getInfoExcludePath(repoPath)
  try {
    if (!existsSync(excludePath)) {
      return
    }
    const content = readFileSync(excludePath, 'utf-8')
    // Why: preserve the original line endings so we don't silently convert
    // CRLF → LF on Windows, which would make git see the file as modified.
    const eol = content.includes('\r\n') ? '\r\n' : '\n'
    const lines = content.split(/\r?\n/)
    let changed = false
    let inOrcaBlock = false
    const filtered: string[] = []
    for (const line of lines) {
      if (line.trim() === ORCA_EXCLUDE_MARKER) {
        inOrcaBlock = true
        filtered.push(line)
        continue
      }
      // Only remove matching lines that are inside the Orca block
      if (inOrcaBlock && line.trim() === pattern) {
        changed = true
        continue
      }
      // A non-pattern, non-blank line after the marker ends the block
      if (inOrcaBlock && line.trim() !== '' && !line.trim().startsWith('/')) {
        inOrcaBlock = false
      }
      filtered.push(line)
    }
    if (!changed) {
      return
    }
    // Clean up the marker if no Orca patterns remain after it
    const markerIdx = filtered.findIndex((l) => l.trim() === ORCA_EXCLUDE_MARKER)
    if (markerIdx !== -1) {
      const hasRemainingPatterns = filtered
        .slice(markerIdx + 1)
        .some((l) => l.trim().startsWith('/'))
      if (!hasRemainingPatterns) {
        filtered.splice(markerIdx, 1)
      }
    }
    writeFileSync(excludePath, filtered.join(eol))
  } catch {
    // Best-effort
  }
}

/**
 * Ensure all nested worktrees have exclude entries in .git/info/exclude.
 * Idempotent — only writes if at least one entry is missing.
 */
/** @internal — exported for testing only */
export function ensureNestedWorktreeExcludes(repoPath: string, worktrees: GitWorktreeInfo[]): void {
  const nestedPatterns: string[] = []
  for (const wt of worktrees) {
    if (wt.isMainWorktree || wt.isBare) {
      continue
    }
    const pattern = nestedExcludePattern(repoPath, wt.path)
    if (pattern) {
      nestedPatterns.push(pattern)
    }
  }
  if (nestedPatterns.length === 0) {
    return
  }

  const excludePath = getInfoExcludePath(repoPath)
  try {
    const content = existsSync(excludePath) ? readFileSync(excludePath, 'utf-8') : ''
    const existingLines = new Set(content.split(/\r?\n/).map((l) => l.trim()))
    const missing = nestedPatterns.filter((p) => !existingLines.has(p))
    if (missing.length === 0) {
      return
    }

    const dir = dirname(excludePath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    const eol = content.includes('\r\n') ? '\r\n' : '\n'
    const hasMarker = content.includes(ORCA_EXCLUDE_MARKER)
    const block = hasMarker
      ? missing.join(eol) + eol
      : `${eol}${ORCA_EXCLUDE_MARKER}${eol}${missing.join(eol)}${eol}`
    writeFileSync(excludePath, content.replace(/\r?\n?$/, eol) + block)
  } catch {
    // Best-effort
  }
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
    let isPrunable = false

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        path = line.slice('worktree '.length)
      } else if (line.startsWith('HEAD ')) {
        head = line.slice('HEAD '.length)
      } else if (line.startsWith('branch ')) {
        branch = line.slice('branch '.length)
      } else if (line === 'bare') {
        isBare = true
      } else if (line.startsWith('prunable ')) {
        isPrunable = true
      }
    }

    if (path) {
      // `git worktree list` always emits the main working tree first.
      worktrees.push({
        path,
        head,
        branch,
        isBare,
        isMainWorktree: worktrees.length === 0,
        isPrunable
      })
    }
  }

  return worktrees
}

/**
 * List all worktrees for a git repo at the given path.
 *
 * Why: also runs self-healing — if any linked worktree's `.git` file is
 * missing but its admin entry still exists, recreate the `.git` file so
 * that git commands inside that worktree work again and the next prune
 * does not permanently destroy the admin entry.
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
    const worktrees = parseWorktreeList(translated)
    healMissingDotGitFiles(repoPath, worktrees)
    // Why: backfill exclude entries for nested worktrees that were created
    // before this protection existed. Runs on every list so that upgrading
    // Orca automatically protects existing nested worktrees.
    ensureNestedWorktreeExcludes(repoPath, worktrees)
    return worktrees
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
  baseBranch?: string,
  refreshLocalBaseRef = false
): void {
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
        gitExecFileSync(['merge-base', '--is-ancestor', localBranch, baseBranch], {
          cwd: repoPath
        })
        // Why: We need to find which worktree (if any) has localBranch checked
        // out, because moving the ref without updating that worktree's files would
        // leave it looking massively dirty. A sibling worktree we don't control is
        // just as vulnerable as the primary one.
        const worktreeListOutput = gitExecFileSync(['worktree', 'list', '--porcelain'], {
          cwd: repoPath
        })
        const worktrees = parseWorktreeList(translateWslOutputPaths(worktreeListOutput, repoPath))
        const fullRef = `refs/heads/${localBranch}`
        const ownerWorktree = worktrees.find((wt) => wt.branch === fullRef)

        if (ownerWorktree) {
          // Why: localBranch is checked out in a worktree. We can only safely
          // update if that worktree is clean, and we must use `reset --hard`
          // (run inside that worktree) so the files move with the ref.
          const status = gitExecFileSync(['status', '--porcelain', '--untracked-files=no'], {
            cwd: ownerWorktree.path
          })
          if (!status.trim()) {
            gitExecFileSync(['reset', '--hard', baseBranch], { cwd: ownerWorktree.path })
          }
        } else {
          // Why: localBranch is not checked out anywhere, so there is no working
          // tree to desync. `update-ref` is safe here.
          gitExecFileSync(['update-ref', fullRef, baseBranch], { cwd: repoPath })
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
  gitExecFileSync(args, { cwd: repoPath })
  addNestedWorktreeExclude(repoPath, worktreePath)
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
  removeNestedWorktreeExclude(repoPath, worktreePath)

  // Why: the previous implementation ran `git worktree prune` after every
  // removal. Prune destroys admin entries for ALL worktrees whose .git files
  // are missing — not just the one being removed. For worktrees nested inside
  // the main repo, this cascaded damage to siblings whose .git files were
  // temporarily inaccessible. `git worktree list --porcelain` already marks
  // stale entries as `prunable`, so we filter those out instead of running
  // a blanket prune that can orphan unrelated worktrees.

  if (!branchName) {
    return
  }

  const worktreesAfterRemoval = await listWorktrees(repoPath)
  const branchStillInUse = worktreesAfterRemoval.some(
    (worktree) => !worktree.isPrunable && normalizeLocalBranchRef(worktree.branch) === branchName
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

/**
 * Remove the admin entry for a single worktree from `.git/worktrees/<name>`.
 *
 * Why: blanket `git worktree prune` destroys admin entries for ALL worktrees
 * whose .git files are missing, which can cascade damage to sibling nested
 * worktrees. Targeted removal only cleans up the specific worktree being
 * deleted, leaving other admin entries intact.
 */
export async function removeWorktreeAdminEntry(
  repoPath: string,
  worktreePath: string
): Promise<void> {
  removeNestedWorktreeExclude(repoPath, worktreePath)
  try {
    const commonDir = resolveGitCommonDir(repoPath)
    if (!commonDir) {
      return
    }
    const worktreesDir = pathJoin(commonDir, 'worktrees')

    if (!existsSync(worktreesDir)) {
      return
    }

    for (const entry of readdirSync(worktreesDir)) {
      const gitdirFile = pathJoin(worktreesDir, entry, 'gitdir')
      try {
        const linkedPath = readFileSync(gitdirFile, 'utf-8').trim()
        // Why: the gitdir file stores the path to the worktree's `.git` file
        // (e.g. `/repo/my-worktree/.git`). Strip the trailing `/.git` to get
        // the worktree root and compare against the path being removed.
        const linkedWorktree = linkedPath.replace(/[/\\]\.git\s*$/, '')
        if (areWorktreePathsEqual(linkedWorktree, worktreePath)) {
          await rm(pathJoin(worktreesDir, entry), { recursive: true, force: true })
          return
        }
      } catch {
        // Skip entries that can't be read (already corrupt / being cleaned up)
      }
    }
  } catch {
    // Best-effort — if we can't determine the admin entry, the stale record
    // will be cleaned up the next time git itself prunes.
  }
}

/**
 * Recreate missing `.git` files for linked worktrees.
 *
 * Why: if a worktree's `.git` file disappears (e.g. due to a rogue operation
 * or filesystem glitch), git commands inside it fall through to the parent
 * repo and the next `git worktree prune` permanently destroys the admin
 * entry — making recovery impossible. Recreating the `.git` file before
 * that can happen heals the worktree automatically.
 */
/** @internal — exported for testing only */
export function healMissingDotGitFiles(repoPath: string, worktrees: GitWorktreeInfo[]): void {
  const linkedWorktrees = worktrees.filter((wt) => !wt.isMainWorktree && !wt.isBare)
  if (linkedWorktrees.length === 0) {
    return
  }

  // Only resolve the common git dir if at least one worktree actually needs healing.
  // Why: use a dedicated `resolved` flag instead of overloading the string value,
  // so a failed resolution is correctly cached as null (not empty string which
  // would be returned as a truthy-looking value on the second call).
  let cachedCommonDir: string | null = null
  let commonDirResolved = false
  function getCommonDir(): string | null {
    if (commonDirResolved) {
      return cachedCommonDir
    }
    commonDirResolved = true
    cachedCommonDir = resolveGitCommonDir(repoPath)
    return cachedCommonDir
  }

  for (const wt of linkedWorktrees) {
    const dotGitPath = pathJoin(wt.path, '.git')
    if (existsSync(dotGitPath)) {
      continue
    }
    // The directory must still exist for healing to make sense.
    if (!existsSync(wt.path)) {
      continue
    }

    const resolved = getCommonDir()
    if (!resolved) {
      break
    }

    // Find the admin entry whose gitdir points to this worktree.
    const worktreesDir = pathJoin(resolved, 'worktrees')
    if (!existsSync(worktreesDir)) {
      break
    }

    try {
      for (const entry of readdirSync(worktreesDir)) {
        const gitdirFile = pathJoin(worktreesDir, entry, 'gitdir')
        try {
          const linkedPath = readFileSync(gitdirFile, 'utf-8').trim()
          const linkedWorktree = linkedPath.replace(/[/\\]\.git\s*$/, '')
          if (areWorktreePathsEqual(linkedWorktree, wt.path)) {
            const adminEntryPath = pathJoin(worktreesDir, entry)
            // Why: use 'wx' (exclusive create) to avoid overwriting a .git
            // file that was concurrently recreated by another process.
            try {
              writeFileSync(dotGitPath, `gitdir: ${adminEntryPath}\n`, { flag: 'wx' })
              console.warn(`[git] Healed missing .git file for worktree at ${wt.path}`)
            } catch {
              // File was concurrently recreated or path is inaccessible — either
              // way, nothing more to do for this worktree.
            }
            break
          }
        } catch {
          // Skip unreadable entries
        }
      }
    } catch {
      // Best-effort — don't break listing if healing fails
    }
  }
}
