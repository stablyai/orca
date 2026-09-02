import { readFile, stat } from 'node:fs/promises'
import * as path from 'node:path'
import { resolveWorktreeHostPath } from '../../../shared/git-metadata-path'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { resolveGitDir } from './resolve-git-dir'

/**
 * Subprocess-free proof of every input one working-tree file diff is built from:
 * the HEAD tree, the index, `.gitmodules` (which decides submodule routing) and
 * the working-tree file itself.
 *
 * Two equal stamps mean `git show HEAD:<path>`, `git show :<path>` and the
 * working-tree bytes would still return what they returned when the stamp was
 * taken, so a caller may reuse a settled diff instead of respawning Git — on a
 * WSL/UNC worktree that trades two `wsl.exe` spawns for a handful of 9p stats.
 *
 * `null` means "cannot prove unchanged" — not a repo, an unreadable layout, or a
 * filesystem that reports no usable mtime — and callers must not cache.
 */
export type WorktreeDiffStamp = {
  /** Opaque; compare for equality only. */
  value: string
  /** Newest mtime any component reported, or -Infinity when every one was absent. */
  newestMtimeMs: number
  capturedAtMs: number
}

/**
 * How long after a component's mtime the stamp has to be taken before a later
 * write is guaranteed to move that mtime.
 *
 * Why 2s: FAT/exFAT truncate mtime to a 2s bucket, the coarsest granularity a
 * repo can realistically sit on. Below the margin a second write inside the same
 * bucket would leave the stamp identical, so the read stays uncached instead.
 */
export const DIFF_STAMP_RACY_WRITE_MARGIN_MS = 2_000

const MISSING = '-'
const ABSENT: StampComponent = { text: MISSING, mtimeMs: Number.NEGATIVE_INFINITY }

type StampComponent = { text: string; mtimeMs: number }

/**
 * A write that lands in the same timestamp bucket as the stamp is invisible, so
 * only a stamp taken a full bucket after its newest component can be trusted.
 *
 * The margin compares two clocks: `capturedAtMs` is this host's, while the mtimes
 * come from whatever wrote the files. On a `\\wsl.localhost` worktree the guest
 * sets them, and a guest running ahead pushes every recently-touched file past the
 * margin — silently, and for as long as the skew lasts. `isDiffStampClockSkewed`
 * separates that from an honestly-too-fresh file so the caller can count it.
 */
export function canProveUnchangedByStamp(stamp: WorktreeDiffStamp): boolean {
  return stamp.capturedAtMs - stamp.newestMtimeMs >= DIFF_STAMP_RACY_WRITE_MARGIN_MS
}

/**
 * True when a component's mtime is in this host's future, which no local write can
 * produce — so the margin above is measuring skew, not freshness, and will keep
 * refusing to store until the clocks converge.
 */
export function isDiffStampClockSkewed(stamp: WorktreeDiffStamp): boolean {
  return Number.isFinite(stamp.newestMtimeMs) && stamp.newestMtimeMs > stamp.capturedAtMs
}

/**
 * Stamp the inputs of one file diff. Pass `includeWorkingTree: false` for a
 * staged diff, which compares HEAD to the index and never reads the working tree.
 */
export async function readWorktreeDiffStamp(
  worktreePath: string,
  filePath: string,
  includeWorkingTree: boolean,
  options: Pick<GitRuntimeOptions, 'wslDistro'> = {}
): Promise<WorktreeDiffStamp | null> {
  const capturedAtMs = Date.now()
  try {
    // Git can run in the distro against a raw Linux worktree path while Node stats it through Win32.
    const hostWorktreePath = resolveWorktreeHostPath(worktreePath, options)
    if (!hostWorktreePath) {
      // Only an empty worktree path lands here, and nothing about it is provably unchanged.
      return null
    }
    // Why still pass options: the host spelling above only encodes the distro when it lands on a
    // UNC share, so a drvfs-spelled worktree needs it again to resolve a non-drvfs gitdir pointer.
    const gitDir = await resolveGitDir(hostWorktreePath, options)
    const [head, index, gitmodules, workingTree] = await Promise.all([
      readHeadComponent(gitDir),
      // Over-invalidates on purpose: git run outside Orca (a terminal `git status`/`git add`)
      // can refresh a stat-dirty index and rewrite this file without changing a single blob,
      // which costs one re-read. That is the safe direction — do not "fix" it by dropping the
      // index from the stamp, because `git add` then becomes invisible and the cache serves a
      // pre-staging diff.
      readFileStampComponent(path.join(gitDir, 'index')),
      readFileStampComponent(path.join(hostWorktreePath, '.gitmodules')),
      includeWorkingTree
        ? readWorkingTreeComponent(path.join(hostWorktreePath, filePath))
        : Promise.resolve(ABSENT)
    ])
    if (!head) {
      return null
    }
    const components = [head, index, gitmodules, workingTree]
    return {
      // Why JSON: a path or a ref can contain any separator character, and an ambiguous
      // join is a stamp collision — two different states that compare equal.
      value: JSON.stringify([
        worktreePath,
        filePath,
        ...components.map((component) => component.text)
      ]),
      newestMtimeMs: Math.max(...components.map((component) => component.mtimeMs)),
      capturedAtMs
    }
  } catch {
    return null
  }
}

/**
 * Identify the commit HEAD resolves to. Reading the tip is what makes a plain
 * commit visible: it rewrites `refs/heads/<branch>` and leaves HEAD untouched.
 *
 * A loose tip is recorded by content, so it needs no mtime margin. Only when no
 * loose ref exists at all — packed refs, the reftable backend, or an unborn
 * branch — does this fall back to the coarser stamps of the files a packed tip
 * moves, and the recorded "no loose ref" marker still catches the ref appearing.
 */
async function readHeadComponent(gitDir: string): Promise<StampComponent | null> {
  const [head, commonDirEntry] = await Promise.all([
    readTrimmedFile(path.join(gitDir, 'HEAD')),
    readTrimmedFile(path.join(gitDir, 'commondir'))
  ])
  if (!head) {
    return null
  }
  const commonDir = commonDirEntry ? path.resolve(gitDir, commonDirEntry) : gitDir
  const refName = head.match(/^ref:\s*(.+?)\s*$/)?.[1]
  if (!refName || !isSafeRefName(refName)) {
    // Detached HEAD already holds the object id; an unrecognized HEAD is covered by its own text.
    return { text: head, mtimeMs: Number.NEGATIVE_INFINITY }
  }
  // Per-worktree refs (`refs/bisect`, `refs/worktree`) live beside the checkout; branches are shared.
  const [perWorktreeTip, sharedTip] = await Promise.all([
    readTrimmedFile(path.join(gitDir, refName)),
    commonDir === gitDir ? Promise.resolve(null) : readTrimmedFile(path.join(commonDir, refName))
  ])
  const looseTip = perWorktreeTip ?? sharedTip
  if (looseTip) {
    // A loose ref shadows any packed entry, so its bytes settle the tip on their own.
    return {
      text: JSON.stringify([head, 'loose', perWorktreeTip ? 'worktree' : 'common', looseTip]),
      mtimeMs: Number.NEGATIVE_INFINITY
    }
  }
  const [packedRefs, reftable] = await Promise.all([
    readFileStampComponent(path.join(commonDir, 'packed-refs')),
    readFileStampComponent(path.join(commonDir, 'reftable'))
  ])
  return {
    text: JSON.stringify([head, 'packed', packedRefs.text, reftable.text]),
    mtimeMs: Math.max(packedRefs.mtimeMs, reftable.mtimeMs)
  }
}

/** Keep a hand-edited HEAD from steering the stamp outside the repo's ref store. */
function isSafeRefName(refName: string): boolean {
  const segments = refName.split(/[\\/]/)
  return (
    segments[0] === 'refs' &&
    segments.length > 1 &&
    segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..') &&
    !path.isAbsolute(refName)
  )
}

async function readTrimmedFile(filePath: string): Promise<string | null> {
  try {
    const trimmed = (await readFile(filePath, 'utf-8')).trim()
    return trimmed.length > 0 ? trimmed : null
  } catch (error) {
    if (isMissingEntryError(error)) {
      return null
    }
    throw error
  }
}

async function readFileStampComponent(filePath: string): Promise<StampComponent> {
  try {
    const stats = await stat(filePath)
    return { text: `${requireMtimeMs(stats.mtimeMs)}:${stats.size}`, mtimeMs: stats.mtimeMs }
  } catch (error) {
    if (isMissingEntryError(error)) {
      return ABSENT
    }
    throw error
  }
}

async function readWorkingTreeComponent(filePath: string): Promise<StampComponent> {
  try {
    const stats = await stat(filePath)
    // Why ino is optional: an atomic-rename save can keep both the size and the mtime bucket,
    // so a changed inode is extra proof — but Windows reports 0 for it on the network
    // redirector behind `\\wsl.localhost`, and requiring an unstable 0 to match would make
    // the stamp never hit on exactly the host this cache exists for. Fold it in only when
    // the filesystem gives a real one.
    const inode = isUsableInode(stats.ino) ? String(stats.ino) : MISSING
    return {
      text: `${requireMtimeMs(stats.mtimeMs)}:${stats.size}:${inode}`,
      mtimeMs: stats.mtimeMs
    }
  } catch (error) {
    if (isMissingEntryError(error)) {
      return ABSENT
    }
    throw error
  }
}

function isUsableInode(ino: unknown): boolean {
  return typeof ino === 'number' && Number.isFinite(ino) && ino !== 0
}

/** A filesystem (or a stub) that reports no usable mtime cannot prove anything unchanged. */
function requireMtimeMs(mtimeMs: unknown): number {
  if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs)) {
    throw new Error('stat reported no usable mtime')
  }
  return mtimeMs
}

function isMissingEntryError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}
