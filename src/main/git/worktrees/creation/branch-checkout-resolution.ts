import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  errorCode,
  forEachBounded,
  readRefFile,
  readRefLink,
  rethrowUnlessMissing,
  throwIfStopped,
  UNRESOLVED_HEAD,
  type GitDirState
} from './git-dir-branch-state'
import { COMMIT_ID } from './git-ref-text'

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
  /** Whether the files can place a checkout; a sole direct owner they cannot place goes straight to Git's listing. */
  canLocate?: (gitDir: string) => Promise<boolean>
  /** Ends an abandoned check early; it then rejects instead of answering from partial reads. */
  stop?: () => boolean
}

const MAX_SYMREF_HOPS = 5
// Per common dir, the checkout and ref whose alias chain last could not be followed: an odd ref tends to stay.
const lastUnresolved = new Map<string, readonly [gitDir: string, ref: string]>()
const MAX_UNRESOLVED_HINTS = 64
const PER_WORKTREE_REF = /^refs\/(?:worktree|bisect|rewritten)\//

/** Git's in-use rule from files for a branch (not an alias: see resolveAliasedBranch); `bareCommonDir`'s own HEAD checks nothing out. */
export async function resolveBranchCheckouts(
  state: GitDirState,
  commonDir: string,
  fullRef: string,
  options: ResolveOptions
): Promise<BranchCheckouts> {
  const result = await resolveFromFiles(state, commonDir, fullRef, options)
  throwIfStopped(options.stop ?? (() => false))
  return result
}

async function resolveFromFiles(
  state: GitDirState,
  commonDir: string,
  fullRef: string,
  { bareCommonDir, firstOwnerSettles = false, canLocate, stop = () => false }: ResolveOptions
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
    const known = looseRefs.get(path) ?? readRefFile(path).catch(unlessUnreadable)
    looseRefs.set(path, known)
    return known
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
  const settled = () => stop() || owners.length > 1 || (firstOwnerSettles && owners.length > 0)
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
  // Aliases could only add owners, and the listing will be needed anyway.
  if (owners.length === 1 && canLocate && !(await canLocate(owners[0]))) {
    return { kind: 'unknown' }
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
    for (let hop = 0; hop <= MAX_SYMREF_HOPS && !unknown && !stop(); hop += 1) {
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
    if (!unknown) {
      rememberUnresolved(commonDir, gitDir, start)
    }
    unknown = true
  }
  // Try that branch first so a lasting odd ref costs one chain, not a pass over every checkout.
  const odd = lastUnresolved.get(commonDir)
  const first = odd && branches.find(([gitDir, ref]) => gitDir === odd[0] && ref === odd[1])
  if (first) {
    await resolve(first)
    if (unknown && !settled()) {
      return { kind: 'unknown' }
    }
  }
  const rest = first ? branches.filter((branch) => branch !== first) : branches
  await forEachBounded(rest, resolve, () => unknown || settled()).catch((error: unknown) => {
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
  lastUnresolved.delete(commonDir)
  return owners.length > 0 ? { kind: 'owned', gitDirs: owners } : { kind: 'free' }
}

function rememberUnresolved(commonDir: string, gitDir: string, ref: string): void {
  lastUnresolved.delete(commonDir)
  lastUnresolved.set(commonDir, [gitDir, ref])
  // Oldest first: a removed repo's hint ages out.
  for (const stale of lastUnresolved.keys()) {
    if (lastUnresolved.size <= MAX_UNRESOLVED_HINTS) {
      break
    }
    lastUnresolved.delete(stale)
  }
}

/** The branch `update-ref` moves for `fullRef`, following loose symrefs as Git does; undefined when the chain leaves `refs/heads/` or does not end. */
async function followBranchAlias(
  commonDir: string,
  fullRef: string,
  stop: () => boolean
): Promise<string | undefined> {
  let ref = fullRef
  for (let hop = 0; hop <= MAX_SYMREF_HOPS; hop += 1) {
    throwIfStopped(stop)
    const loose = await readRefFile(join(commonDir, ref)).catch(unlessUnreadable)
    if (!loose.startsWith('ref: ')) {
      return ref
    }
    ref = loose.slice('ref: '.length)
    if (loose === UNRESOLVED_HEAD || !ref.startsWith('refs/heads/')) {
      return undefined
    }
  }
  return undefined
}

/** The branch `update-ref` would move, and whether a rebase or bisect reserves it under either name. */
export async function resolveAliasedBranch(
  state: GitDirState,
  commonDir: string,
  fullRef: string,
  stop: () => boolean = () => false
): Promise<{ branch?: string; reserved: boolean }> {
  const branch = await followBranchAlias(commonDir, fullRef, stop)
  const reserved =
    state.reserved.has(fullRef) || (branch !== undefined && state.reserved.has(branch))
  return { branch, reserved }
}

// Git cannot follow a ref it cannot read either, so that ref aliases nothing.
function unlessUnreadable(error: unknown): string {
  const code = errorCode(error)
  if (code === 'EACCES' || code === 'EPERM') {
    return ''
  }
  throw error
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
