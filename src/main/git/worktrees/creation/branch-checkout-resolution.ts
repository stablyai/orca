import { stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  COMMIT_ID,
  forEachBounded,
  isSamePath,
  readLinkedCheckoutDir,
  readRefFile,
  readRefLink,
  rethrowUnlessMissing,
  UNRESOLVED_HEAD,
  type GitDirState
} from './git-dir-branch-state'

export type BranchCheckouts =
  | { kind: 'free' }
  /** Git dirs whose HEAD names the branch, directly or through branch symrefs. */
  | { kind: 'owned'; gitDirs: string[] }
  /** The files cannot tell (reftable, odd refs or symlinks); only Git's own listing can. */
  | { kind: 'unknown' }

type ResolveOptions = {
  /** This git dir's own HEAD checks nothing out (a bare repo). */
  bareCommonDir?: string
  /** Only whether the branch is checked out matters, not where or how often. */
  firstOwnerSettles?: boolean
}

const MAX_SYMREF_HOPS = 5
const PER_WORKTREE_REF = /^refs\/(?:worktree|bisect|rewritten)\//

/** Git's in-use rule from files; `bareCommonDir`'s own HEAD checks nothing out. Reservations are separate. */
export async function resolveBranchCheckouts(
  state: GitDirState,
  commonDir: string,
  fullRef: string,
  { bareCommonDir, firstOwnerSettles = false }: ResolveOptions
): Promise<BranchCheckouts> {
  // A case-insensitive file system resolves `refs/heads/Main` to a loose `main`, which the write itself may create.
  const foldRef = (await pathExists(join(commonDir, 'head')))
    ? (ref: string) => ref.toLowerCase()
    : (ref: string) => ref
  const target = foldRef(fullRef)
  const looseRefs = new Map<string, Promise<string>>()
  // Per-worktree refs (refs/worktree/, refs/bisect/, refs/rewritten/) live in their own git dir.
  const readLooseRef = (ref: string, gitDir: string) => {
    const path = join(PER_WORKTREE_REF.test(ref) ? gitDir : commonDir, ref)
    const known = looseRefs.get(path) ?? readRefFile(path)
    looseRefs.set(path, known)
    return known
  }
  // update-ref follows a symref, which would move some other branch.
  if ((await readLooseRef(fullRef, commonDir)).startsWith('ref: ')) {
    return { kind: 'unknown' }
  }
  const owners: string[] = []
  const branches: [gitDir: string, ref: string][] = []
  const unnamed: string[] = []
  // False when the HEAD rules out file-based resolution.
  const classify = (gitDir: string, head: string): boolean => {
    const ref = head.slice('ref: '.length)
    if (!head.startsWith('ref: ') || head === UNRESOLVED_HEAD || !ref.startsWith('refs/')) {
      return false
    }
    if (foldRef(ref) === target) {
      owners.push(gitDir)
    } else {
      branches.push([gitDir, ref])
    }
    return true
  }
  const settled = () => owners.length > 1 || (firstOwnerSettles && owners.length > 0)
  for (const [gitDir, head] of state.heads) {
    if (gitDir === bareCommonDir) {
      continue
    }
    // A HEAD without a `ref:` line may be a symlink naming a ref (read as empty when that ref is packed).
    if (!head.startsWith('ref: ')) {
      unnamed.push(gitDir)
    } else if (!classify(gitDir, head)) {
      return { kind: 'unknown' }
    }
  }
  // Two direct checkouts, or one when only occupancy matters, already settle it.
  if (settled()) {
    return { kind: 'owned', gitDirs: owners }
  }
  let unresolvable = false
  const settle = (gitDir: string, link: string | undefined) => {
    const head = link ?? state.heads.get(gitDir) ?? ''
    unresolvable ||= head.startsWith('ref: ')
      ? !classify(gitDir, head)
      : head !== '' && !COMMIT_ID.test(head)
  }
  if (state.linksRead) {
    // The sweep already followed symlinked HEADs; these are plain content.
    for (const gitDir of unnamed) {
      settle(gitDir, undefined)
    }
  } else {
    await forEachBounded(
      unnamed,
      async (gitDir) => settle(gitDir, await readRefLink(join(gitDir, 'HEAD'))),
      settled
    )
  }
  if (settled()) {
    return { kind: 'owned', gitDirs: owners }
  }
  if (unresolvable) {
    return { kind: 'unknown' }
  }
  let unknown = false
  const resolve = async ([gitDir, start]: [string, string]) => {
    if (settled()) {
      return
    }
    let ref = start
    for (let hop = 0; hop <= MAX_SYMREF_HOPS && !unknown; hop += 1) {
      // Packed and missing refs are never symrefs.
      const loose = await readLooseRef(ref, gitDir)
      if (!loose.startsWith('ref: ')) {
        return
      }
      ref = loose.slice('ref: '.length)
      if (!ref.startsWith('refs/') || loose === UNRESOLVED_HEAD) {
        break
      }
      if (foldRef(ref) === target) {
        owners.push(gitDir)
        return
      }
    }
    unknown = true
  }
  await forEachBounded(branches, resolve, () => unknown || settled()).catch((error: unknown) => {
    unknown = true
    throw error
  })
  // An owner already found settles it even if another chain could not be followed.
  if (settled()) {
    return { kind: 'owned', gitDirs: owners }
  }
  if (unknown) {
    return { kind: 'unknown' }
  }
  return owners.length > 0 ? { kind: 'owned', gitDirs: owners } : { kind: 'free' }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    rethrowUnlessMissing(error)
    return false
  }
}

/** The checkout a sole owning git dir belongs to; undefined when the files cannot prove it. */
export async function readOwnerCheckoutPath(
  repoPath: string,
  gitDir: string,
  commonDir: string,
  toHostPath: (path: string) => string
): Promise<string | undefined> {
  if (gitDir !== commonDir) {
    return readLinkedCheckoutDir(gitDir, toHostPath)
  }
  if (await isSamePath(join(repoPath, '.git'), commonDir)) {
    return repoPath
  }
  // From a linked repo path: the primary checkout holds the common dir as its `.git`.
  return basename(commonDir) === '.git' ? dirname(commonDir) : undefined
}
