import { readdir, readFile, readlink, realpath, stat } from 'node:fs/promises'
import { normalizeRuntimePathForComparison } from '../../../../shared/file-access/cross-platform-path'
import { dirname, isAbsolute, join } from 'node:path'

/** A HEAD whose branch the files cannot tell: reftable leaves this placeholder, and odd symlinks map to it. */
export const UNRESOLVED_HEAD = 'ref: refs/heads/.invalid'

export type GitDirState = {
  /** Each git dir's HEAD file, keyed by git dir. */
  heads: ReadonlyMap<string, string>
  /** Branches a rebase (head-name, --update-refs) or bisect reserves: Git's own in-use rule. */
  reserved: ReadonlySet<string>
}

// Reads files only: this runs inside an admitted command, where running Git could wait on its own slot.
/** `fullRef` reserved skips the symlink probes: nothing else can change the answer. */
export async function readGitDirState(commonDir: string, fullRef: string): Promise<GitDirState> {
  // Fail closed: an unreadable common dir must not look like "nothing in use".
  if (!(await stat(commonDir)).isDirectory()) {
    throw new Error(`${commonDir} is not a Git directory`)
  }
  const gitDirs = [commonDir]
  try {
    for (const entry of await readdir(join(commonDir, 'worktrees'), { withFileTypes: true })) {
      const gitDir = join(commonDir, 'worktrees', entry.name)
      // Git follows a symlinked registration, so it counts too.
      if (entry.isDirectory() || (entry.isSymbolicLink() && (await isDirectory(gitDir)))) {
        gitDirs.push(gitDir)
      }
    }
  } catch (error) {
    rethrowUnlessMissing(error)
  }
  const heads = new Map<string, string>()
  const reserved = new Set<string>()
  await Promise.all(
    gitDirs.map(async (gitDir) => {
      const [head, rebaseMerge, rebaseApply, updateRefs, bisectStart] = await Promise.all([
        readOptional(join(gitDir, 'HEAD')),
        readOptional(join(gitDir, 'rebase-merge', 'head-name')),
        readOptional(join(gitDir, 'rebase-apply', 'head-name')),
        readOptional(join(gitDir, 'rebase-merge', 'update-refs')),
        readOptional(join(gitDir, 'BISECT_START'))
      ])
      heads.set(gitDir, normalizeHead(head))
      for (const line of [rebaseMerge, rebaseApply, updateRefs].flatMap((text) =>
        text.split('\n')
      )) {
        if (line.startsWith('refs/heads/')) {
          reserved.add(line.trim())
        }
      }
      const bisected = bisectStart.trim()
      if (bisected) {
        reserved.add(bisected.startsWith('refs/') ? bisected : `refs/heads/${bisected}`)
      }
    })
  )
  if (reserved.has(fullRef)) {
    return { heads, reserved }
  }
  // Only once the sweep succeeded: a HEAD without a `ref:` line may be a symlink naming a ref.
  const unnamed = [...heads]
    .filter(([, head]) => !head.startsWith('ref: '))
    .map(([gitDir]) => gitDir)
  await forEachBounded(unnamed, async (gitDir) => {
    const link = await readRefLink(join(gitDir, 'HEAD'))
    if (link !== undefined) {
      heads.set(gitDir, link)
    }
  })
  return { heads, reserved }
}

// Git treats a symlinked HEAD or ref as a symref to the ref it links to (core.preferSymlinkRefs).
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
  return target.startsWith('refs/') ? `ref: ${target}` : UNRESOLVED_HEAD
}

const READ_CONCURRENCY = 16

/** Runs at most `READ_CONCURRENCY` at once and starts nothing after a failure. */
export async function forEachBounded<T>(
  items: readonly T[],
  run: (item: T) => Promise<void>
): Promise<void> {
  let next = 0
  let failed = false
  await Promise.all(
    Array.from({ length: Math.min(READ_CONCURRENCY, items.length) }, async () => {
      while (next < items.length && !failed) {
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

export async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    rethrowUnlessMissing(error)
    return ''
  }
}

function errorCode(error: unknown): unknown {
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

/** A linked git dir's checkout, from its `gitdir` file, only when that checkout's `.git` file points back. */
export async function readLinkedCheckoutDir(
  gitDir: string,
  toHostPath: (path: string) => string
): Promise<string | undefined> {
  try {
    return await readVerifiedCheckoutDir(gitDir, toHostPath)
  } catch {
    // Unreadable or odd: Git's listing decides.
    return undefined
  }
}

async function readVerifiedCheckoutDir(
  gitDir: string,
  toHostPath: (path: string) => string
): Promise<string | undefined> {
  const named = (await readOptional(join(gitDir, 'gitdir'))).replace(/\r?\n$/, '')
  if (!named.endsWith('/.git')) {
    return undefined
  }
  // Git 2.48+ may write it relative to the git dir, resolved through any symlink.
  const dotGit = isAbsolute(named) ? toHostPath(named) : join(await realpath(gitDir), named)
  const pointer = /^gitdir:\s*(.+?)\r?\n?$/.exec(await readOptional(dotGit))?.[1]
  if (!pointer) {
    return undefined
  }
  const pointed = isAbsolute(pointer) ? toHostPath(pointer) : join(dirname(dotGit), pointer)
  return (await isSamePath(pointed, gitDir)) ? dirname(dotGit) : undefined
}
