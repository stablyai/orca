import { readFile, stat } from 'node:fs/promises'
import * as path from 'node:path'
import { resolveWorktreeHostPath } from '../../../shared/git-metadata-path'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { resolveGitDir } from './resolve-git-dir'

/** Stamp HEAD, index, routing metadata and working-file inputs without Git; null forbids caching. */
export type WorktreeDiffStamp = {
  /** Opaque; compare for equality only. */
  value: string
  /** Newest mtime any component reported, or -Infinity when every one was absent. */
  newestMtimeMs: number
  capturedAtMs: number
}

// Wait beyond FAT/exFAT's 2s mtime bucket so another write cannot share a recent timestamp.
export const DIFF_STAMP_RACY_WRITE_MARGIN_MS = 2_000

const MISSING = '-'
const ABSENT: StampComponent = { text: MISSING, mtimeMs: Number.NEGATIVE_INFINITY }

type StampComponent = { text: string; mtimeMs: number }

/** Refuse stamps within the mtime bucket; separately count future mtimes to expose host/guest clock skew. */
export function canProveUnchangedByStamp(stamp: WorktreeDiffStamp): boolean {
  return stamp.capturedAtMs - stamp.newestMtimeMs >= DIFF_STAMP_RACY_WRITE_MARGIN_MS
}

/** Future component mtimes cannot satisfy the cache's freshness margin. */
export function isDiffStampClockSkewed(stamp: WorktreeDiffStamp): boolean {
  return Number.isFinite(stamp.newestMtimeMs) && stamp.newestMtimeMs > stamp.capturedAtMs
}

/** Staged diffs compare HEAD/index only; omit working-tree inputs for those reads. */
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
      return null
    }
    // Retain distro options for non-drvfs gitdir pointers even after the worktree becomes a drive path.
    const gitDir = await resolveGitDir(hostWorktreePath, options)
    const [head, index, gitmodules, workingTree] = await Promise.all([
      readHeadComponent(gitDir),
      // Keep index stamps even when only stat metadata changed: dropping them would make staging invisible.
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
      // Structural encoding avoids collisions when paths or refs contain separators.
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

/** Read loose ref content to detect commits without HEAD changes; packed/reftable/unborn tips use file stamps. */
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
    // Inodes detect atomic replacement, but zero/unstable network-redirector values cannot improve the stamp.
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
