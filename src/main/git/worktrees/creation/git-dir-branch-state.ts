import { constants } from 'node:fs'
import { lstat, open, readdir, readlink, realpath, stat } from 'node:fs/promises'
import { normalizeRuntimePathForComparison } from '../../../../shared/file-access/cross-platform-path'
import { join } from 'node:path'

/** A HEAD whose branch the files cannot tell: reftable leaves this placeholder, and odd symlinks map to it. */
export const UNRESOLVED_HEAD = 'ref: refs/heads/.invalid'

export type GitDirState = {
  /** Each git dir's HEAD file, keyed by git dir. */
  heads: ReadonlyMap<string, string>
  /** Branches a rebase (head-name, --update-refs) or bisect reserves: Git's own in-use rule. */
  reserved: ReadonlySet<string>
  /** HEADs were read without following symlinks, so a symlinked HEAD already names its ref. */
  linksRead: boolean
}

// Reads files only: this runs inside an admitted command, where running Git could wait on its own slot.
export async function readGitDirState(commonDir: string): Promise<GitDirState> {
  // Fail closed: an unreadable common dir must not look like "nothing in use".
  if (!(await stat(commonDir)).isDirectory()) {
    throw new Error(`${commonDir} is not a Git directory`)
  }
  const gitDirs = [commonDir]
  try {
    const linked: string[] = []
    for (const entry of await readdir(join(commonDir, 'worktrees'), { withFileTypes: true })) {
      const gitDir = join(commonDir, 'worktrees', entry.name)
      if (entry.isDirectory()) {
        gitDirs.push(gitDir)
      } else if (entry.isSymbolicLink()) {
        linked.push(gitDir)
      }
    }
    // Git follows a symlinked registration, so it counts too.
    await forEachBounded(linked, async (gitDir) => {
      if (await isDirectory(gitDir)) {
        gitDirs.push(gitDir)
      }
    })
  } catch (error) {
    rethrowUnlessMissing(error)
  }
  const heads = new Map<string, string>()
  const reserved = new Set<string>()
  // Bounded: thousands of worktrees must not flood the main process's file system pool.
  await forEachBounded(gitDirs, async (gitDir) => {
    const [head, rebaseMerge, rebaseApply, updateRefs, bisectStart] = await Promise.all([
      NO_FOLLOW === undefined
        ? readOptional(join(gitDir, 'HEAD'))
        : readRefFile(join(gitDir, 'HEAD')),
      readOptional(join(gitDir, 'rebase-merge', 'head-name')),
      readOptional(join(gitDir, 'rebase-apply', 'head-name')),
      readOptional(join(gitDir, 'rebase-merge', 'update-refs')),
      readOptional(join(gitDir, 'BISECT_START'))
    ])
    heads.set(gitDir, normalizeHead(head))
    for (const line of [rebaseMerge, rebaseApply, updateRefs].flatMap((text) => text.split('\n'))) {
      if (line.startsWith('refs/heads/')) {
        reserved.add(line.trim())
      }
    }
    const bisected = bisectStart.trim()
    if (bisected) {
      reserved.add(bisected.startsWith('refs/') ? bisected : `refs/heads/${bisected}`)
    }
  })
  return { heads, reserved, linksRead: NO_FOLLOW !== undefined }
}

// Git treats a symlinked HEAD or ref as a symref to the ref it links to (core.preferSymlinkRefs), and reads any other link's target content.
export async function readRefLink(path: string): Promise<string | undefined> {
  let target: string
  try {
    target = await readlink(path)
  } catch (error) {
    const code = errorCode(error)
    if (code === 'EINVAL' || code === 'UNKNOWN') {
      return undefined
    }
    rethrowUnlessMissing(error)
    return undefined
  }
  return target.startsWith('refs/') ? `ref: ${target}` : readRefContent(path)
}

// Refs are a short line; anything larger, or not a regular file, is left to Git's listing.
const MAX_REF_BYTES = 4096

/** A ref's content; '' for a directory (`refs/heads/feature/` beside an unborn `feature` holds no ref). */
async function readSmallRef(path: string, extraFlags = 0): Promise<string> {
  const text = await readBoundedFile(path, MAX_REF_BYTES, extraFlags)
  return text === null ? '' : text === undefined ? UNRESOLVED_HEAD : normalizeHead(text)
}

/** A regular file's content, opened without blocking on a FIFO; null for a directory, undefined when not regular or over `maxBytes`. */
async function readBoundedFile(
  path: string,
  maxBytes?: number,
  extraFlags = 0
): Promise<string | null | undefined> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | extraFlags)
  try {
    const info = await handle.stat()
    if (info.isDirectory()) {
      return null
    }
    if (!info.isFile() || (maxBytes !== undefined && info.size > maxBytes)) {
      return undefined
    }
    if (maxBytes === undefined) {
      // Chunked, with Node's own size ceiling.
      return await handle.readFile('utf8')
    }
    // One spare byte shows a file that grew past its stat.
    const buffer = Buffer.allocUnsafe(info.size + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return bytesRead > info.size ? undefined : buffer.toString('utf8', 0, bytesRead)
  } finally {
    await handle.close()
  }
}

async function readRefContent(path: string): Promise<string> {
  try {
    return await readSmallRef(path)
  } catch (error) {
    rethrowUnlessMissing(error)
    return ''
  }
}

/** A linked git dir whose HEAD the files cannot tell, such as a reftable placeholder. */
export function hasLinkedPlaceholderHead(state: GitDirState, commonDir: string): boolean {
  for (const [gitDir, head] of state.heads) {
    if (gitDir !== commonDir && head === UNRESOLVED_HEAD) {
      return true
    }
  }
  return false
}

const READ_CONCURRENCY = 16

/** Runs at most `READ_CONCURRENCY` at once; starts nothing after a failure or once `done()` holds. */
export async function forEachBounded<T>(
  items: readonly T[],
  run: (item: T) => Promise<void>,
  done: () => boolean = () => false
): Promise<void> {
  let next = 0
  let failed = false
  await Promise.all(
    Array.from({ length: Math.min(READ_CONCURRENCY, items.length) }, async () => {
      while (next < items.length && !failed && !done()) {
        const item = items[next++]
        try {
          await run(item)
        } catch (error) {
          failed = true
          throw error
        }
      }
    })
  )
}

// Git reads `ref:` followed by any whitespace; spell it one way.
export function normalizeHead(text: string): string {
  const trimmed = text.trim()
  const symref = /^ref:\s*(\S+)$/.exec(trimmed)
  return symref ? `ref: ${symref[1]}` : trimmed
}

export const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/** A metadata file's content, '' when missing; throws for anything but a regular file (of at most `maxBytes`). */
export async function readOptional(path: string, maxBytes?: number): Promise<string> {
  let text: string | null | undefined
  try {
    text = await readBoundedFile(path, maxBytes)
  } catch (error) {
    rethrowUnlessMissing(error)
    return ''
  }
  if (typeof text !== 'string') {
    throw new Error(`Not a readable regular file: ${path}`)
  }
  return text
}

export function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

export function rethrowUnlessMissing(error: unknown): void {
  const code = errorCode(error)
  if (code !== 'ENOENT' && code !== 'ENOTDIR') {
    throw error
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch (error) {
    rethrowUnlessMissing(error)
    return false
  }
}

/** Same file system entry after resolving symlinks; false when either is missing. */
export async function isSamePath(left: string, right: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([realpath(left), realpath(right)])
    return normalizeRuntimePathForComparison(a) === normalizeRuntimePathForComparison(b)
  } catch {
    return false
  }
}

// One no-follow read per ref where the platform has O_NOFOLLOW (not Windows).
const NO_FOLLOW = constants.O_NOFOLLOW

/** A ref file's content, or `ref: <target>` for a symlinked one; '' when missing or a directory. */
export async function readRefFile(path: string): Promise<string> {
  if (NO_FOLLOW === undefined) {
    return readRefFileByLstat(path)
  }
  try {
    return await readSmallRef(path, NO_FOLLOW)
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ELOOP' || code === 'EMLINK') {
      return (await readRefLink(path)) ?? UNRESOLVED_HEAD
    }
    if (code === 'EISDIR') {
      return ''
    }
    rethrowUnlessMissing(error)
    return ''
  }
}

async function readRefFileByLstat(path: string): Promise<string> {
  try {
    const entry = await lstat(path)
    if (entry.isSymbolicLink()) {
      return (await readRefLink(path)) ?? UNRESOLVED_HEAD
    }
    if (entry.isDirectory()) {
      return ''
    }
  } catch (error) {
    rethrowUnlessMissing(error)
    return ''
  }
  return readRefContent(path)
}
