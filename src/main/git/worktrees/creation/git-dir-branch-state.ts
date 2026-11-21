import { readdir, readFile, readlink, realpath, stat } from 'node:fs/promises'
import { normalizeRuntimePathForComparison } from '../../../../shared/file-access/cross-platform-path'
import { join } from 'node:path'

/** A HEAD whose branch the files cannot tell: reftable leaves this placeholder, and odd symlinks map to it. */
export const UNRESOLVED_HEAD = 'ref: refs/heads/.invalid'

export type GitDirState = {
  /** Each git dir's HEAD file, keyed by git dir. */
  heads: ReadonlyMap<string, string>
  /** Branches a rebase (head-name, --update-refs) or bisect reserves: Git's own in-use rule. */
  reserved: ReadonlySet<string>
}

// Reads files only: this runs inside an admitted command, where running Git could wait on its own slot.
export async function readGitDirState(commonDir: string): Promise<GitDirState> {
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
        readHead(gitDir),
        readOptional(join(gitDir, 'rebase-merge', 'head-name')),
        readOptional(join(gitDir, 'rebase-apply', 'head-name')),
        readOptional(join(gitDir, 'rebase-merge', 'update-refs')),
        readOptional(join(gitDir, 'BISECT_START'))
      ])
      heads.set(gitDir, head)
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
  return { heads, reserved }
}

// Git accepts a symlinked HEAD: read its content, else name the ref it links to.
async function readHead(gitDir: string): Promise<string> {
  const path = join(gitDir, 'HEAD')
  const content = (await readOptional(path)).trim()
  // Only a HEAD without a `ref:` line can be a symlink that names a branch.
  if (content.startsWith('ref: ')) {
    return content
  }
  let target: string
  try {
    target = await readlink(path)
  } catch (error) {
    const code = errorCode(error)
    if (code === 'EINVAL' || code === 'UNKNOWN') {
      return content
    }
    rethrowUnlessMissing(error)
    return ''
  }
  return target.startsWith('refs/') ? `ref: ${target}` : UNRESOLVED_HEAD
}

async function readOptional(path: string): Promise<string> {
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

function rethrowUnlessMissing(error: unknown): void {
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

export type BranchCheckouts =
  | { kind: 'free' }
  /** Git dirs whose HEAD names the branch, directly or through branch symrefs. */
  | { kind: 'owned'; gitDirs: string[] }
  /** The files cannot tell (reftable, odd refs or symlinks); only Git's own listing can. */
  | { kind: 'unknown' }

const MAX_SYMREF_HOPS = 5

/** Git's in-use rule from files; `bareCommonDir`'s own HEAD checks nothing out. Reservations are separate. */
export async function resolveBranchCheckouts(
  { heads }: GitDirState,
  commonDir: string,
  fullRef: string,
  bareCommonDir: string | undefined
): Promise<BranchCheckouts> {
  // A case-insensitive file system resolves `Main` to `main`; matching both only ever skips.
  const target = fullRef.toLowerCase()
  const looseRefs = new Map<string, Promise<string>>()
  const readLooseRef = (ref: string) => {
    const known =
      looseRefs.get(ref) ?? readOptional(join(commonDir, ref)).then((text) => text.trim())
    looseRefs.set(ref, known)
    return known
  }
  // update-ref follows a symref, which would move some other branch.
  if ((await readLooseRef(fullRef)).startsWith('ref: ')) {
    return { kind: 'unknown' }
  }
  const owners: string[] = []
  let unknown = false
  await Promise.all(
    [...heads].map(async ([gitDir, head]) => {
      if (gitDir === bareCommonDir || !head.startsWith('ref: ')) {
        return
      }
      let ref = head.slice('ref: '.length)
      for (let hop = 0; hop <= MAX_SYMREF_HOPS; hop += 1) {
        if (head === UNRESOLVED_HEAD || !ref.startsWith('refs/heads/')) {
          unknown = true
          return
        }
        if (ref.toLowerCase() === target) {
          owners.push(gitDir)
          return
        }
        // Packed and missing refs are never symrefs.
        const loose = await readLooseRef(ref)
        if (!loose.startsWith('ref: ')) {
          return
        }
        ref = loose.slice('ref: '.length)
      }
      unknown = true
    })
  )
  if (unknown) {
    return { kind: 'unknown' }
  }
  return owners.length > 0 ? { kind: 'owned', gitDirs: owners } : { kind: 'free' }
}
