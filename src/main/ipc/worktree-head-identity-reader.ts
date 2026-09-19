import { readdir, readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { WorktreeHeadIdentity } from '../../shared/worktree/types'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import {
  FULL_HEAD_IDENTITY_SCOPE,
  headIdentityEntryKey,
  type WorktreeHeadIdentityScope
} from './worktree-head-identity-scope'

// Why: the whole point of this reader is replacing `git worktree list` fanout
// with bounded metadata-file reads, so head freshness never re-creates the
// spawn pressure that stalled terminal input. Keep it spawn-free.

const MAX_SYMREF_DEPTH = 5
// Head identity refreshes run on every git-common poll. Keep metadata reads
// bounded while avoiding a serial round trip per linked worktree (especially
// noticeable on WSL/UNC and network-backed worktrees).
const HEAD_IDENTITY_READ_CONCURRENCY = 8

/** Per-common-dir memo so a scoped refresh re-reads only the entries a watcher
 *  burst could have moved. Misses are never cached: an unresolvable read may be
 *  a transient fs error, so it must be retried rather than remembered. */
export type WorktreeHeadIdentityCache = {
  /** admin entry dir name → last resolved identity. */
  entries: Map<string, WorktreeHeadIdentity>
  /** Entries whose last read failed for a reason other than absence. The memo
   *  keeps their last verified identity; the next pass must re-read them. */
  unverified: Set<string>
  /** last `worktrees/` listing, in readdir order; null before first enumeration. */
  entryNames: string[] | null
  primary: WorktreeHeadIdentity | null
  primaryUnverified: boolean
}

export function createWorktreeHeadIdentityCache(): WorktreeHeadIdentityCache {
  return {
    entries: new Map(),
    unverified: new Set(),
    entryNames: null,
    primary: null,
    primaryUnverified: false
  }
}

export type GitCommonHeadIdentityRead = {
  identities: WorktreeHeadIdentity[]
  /** False when this pass did not fully observe the repo — `worktrees/` could
   *  not be enumerated, or an entry's metadata could not be read. Callers that
   *  treat a full read as a freshness checkpoint must not do so on false. */
  complete: boolean
}

/** ref → oid resolved during one pass; null means the ref no longer resolves. */
type ResolvedRefOids = Map<string, string | null>

// Why: a read that failed for any reason other than absence is an UNKNOWN, not
// an absence — the same distinction AGENTS.md draws for the SSH verdict
// vocabulary. Collapsing the two evicts identities Orca still knows and turns a
// single EMFILE into a full re-read of every worktree on the next pass.
const UNREADABLE = Symbol('unreadable')
type Unreadable = typeof UNREADABLE

async function readTrimmedFile(path: string): Promise<string | null | Unreadable> {
  try {
    return (await readFile(path, 'utf8')).trim()
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : UNREADABLE
  }
}

// packed-refs lines are `<oid> <ref>`; `#` headers and `^` peel lines skipped.
async function readPackedRefs(commonDirPath: string): Promise<Map<string, string> | Unreadable> {
  const refs = new Map<string, string>()
  const content = await readTrimmedFile(join(commonDirPath, 'packed-refs'))
  if (content === UNREADABLE) {
    return UNREADABLE
  }
  // No packed-refs file at all is a fact: every ref is loose.
  if (content === null) {
    return refs
  }
  for (const line of content.split('\n')) {
    if (!line || line.startsWith('#') || line.startsWith('^')) {
      continue
    }
    const separator = line.indexOf(' ')
    if (separator <= 0) {
      continue
    }
    refs.set(line.slice(separator + 1).trim(), line.slice(0, separator))
  }
  return refs
}

// Why: ref content comes from repo files an attacker can craft. Git forbids
// `\` and `:` in ref names, and on Windows `join` also treats `\` as a
// separator — both must be rejected before splicing the ref into a file path.
function isSafeRefName(ref: string): boolean {
  if (ref.length === 0 || ref.includes('\\') || ref.includes(':')) {
    return false
  }
  return !ref.split('/').some((part) => part === '..' || part === '')
}

// SHA-1 (40) or SHA-256 (64) object id. Anything else read from disk is not a
// head and must never be emitted — this also caps what any path escape could leak.
const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

function asObjectId(value: string | null | undefined): string | null {
  return value != null && OBJECT_ID_PATTERN.test(value) ? value : null
}

async function resolveRefToOid(
  commonDirPath: string,
  ref: string,
  packedRefs: () => Promise<Map<string, string> | Unreadable>
): Promise<string | null | Unreadable> {
  let current = ref
  for (let depth = 0; depth < MAX_SYMREF_DEPTH; depth++) {
    if (!isSafeRefName(current)) {
      return null
    }
    // Branch refs are shared repo state, so loose files live in the common dir.
    const loose = await readTrimmedFile(join(commonDirPath, ...current.split('/')))
    if (loose === UNREADABLE) {
      return UNREADABLE
    }
    if (loose === null) {
      const packed = await packedRefs()
      return packed === UNREADABLE ? UNREADABLE : asObjectId(packed.get(current))
    }
    if (loose.startsWith('ref: ')) {
      current = loose.slice('ref: '.length).trim()
      continue
    }
    return asObjectId(loose)
  }
  return null
}

async function readHeadIdentity(
  commonDirPath: string,
  headFilePath: string,
  worktreePath: string,
  packedRefs: () => Promise<Map<string, string> | Unreadable>,
  resolved: ResolvedRefOids
): Promise<WorktreeHeadIdentity | null | Unreadable> {
  const head = await readTrimmedFile(headFilePath)
  if (head === UNREADABLE) {
    return UNREADABLE
  }
  if (!head) {
    return null
  }
  if (head.startsWith('ref: ')) {
    const ref = head.slice('ref: '.length).trim()
    const oid = await resolveRefToOid(commonDirPath, ref, packedRefs)
    // Only definite outcomes are replayed onto siblings; an unknown must not
    // evict every other worktree that shares this branch.
    if (oid === UNREADABLE) {
      return UNREADABLE
    }
    resolved.set(ref, oid)
    // Unborn branches (no commit yet) stay covered by the structural listing.
    if (!oid) {
      return null
    }
    return { worktreePath, head: oid, branch: ref }
  }
  const detachedOid = asObjectId(head)
  return detachedOid ? { worktreePath, head: detachedOid, branch: null } : null
}

async function readLinkedEntryIdentity(
  commonDirPath: string,
  entryName: string,
  packedRefs: () => Promise<Map<string, string> | Unreadable>,
  resolved: ResolvedRefOids
): Promise<WorktreeHeadIdentity | null | Unreadable> {
  const entryPath = join(commonDirPath, 'worktrees', entryName)
  const gitdirContent = await readTrimmedFile(join(entryPath, 'gitdir'))
  if (gitdirContent === UNREADABLE) {
    return UNREADABLE
  }
  if (!gitdirContent) {
    return null
  }
  // `gitdir` holds `<worktree>/.git`, absolute or (with relative-path
  // worktrees) relative to the entry dir.
  const gitdirAbsolute = isAbsolute(gitdirContent) ? gitdirContent : join(entryPath, gitdirContent)
  return readHeadIdentity(
    commonDirPath,
    join(entryPath, 'HEAD'),
    dirname(gitdirAbsolute),
    packedRefs,
    resolved
  )
}

// Why: mirrors worktree-git-common-polling — a TRANSIENT readdir failure
// (EIO/ESTALE/EMFILE, network hiccup) must not masquerade as "every worktree
// removed" and drop the whole memo. Only a genuinely absent dir is empty.
async function listLinkedEntryNames(commonDirPath: string): Promise<string[] | null> {
  try {
    const entries = await readdir(join(commonDirPath, 'worktrees'), { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null
  }
}

function knowsEveryScopedEntry(
  entryKeys: readonly string[],
  scope: WorktreeHeadIdentityScope
): boolean {
  if (scope.entryNames.size === 0) {
    return true
  }
  const known = new Set(entryKeys)
  return [...scope.entryNames].every((key) => known.has(key))
}

// Why: `git worktree add --force` lets several worktrees share one branch, and
// only the committing worktree's HEAD reflog is appended. Replaying every ref
// resolved this pass onto the cached entries that point at it keeps the others
// current without re-reading their metadata.
// A ref that stopped resolving evicts every cached row on it, including rows
// this pass never read: if the ref really is gone their oids are stale, and we
// cannot tell that from a transient miss. Evicting costs a re-read next pass;
// keeping would serve a head we can no longer justify.
function retargetCachedIdentity(
  identity: WorktreeHeadIdentity,
  resolved: ResolvedRefOids
): WorktreeHeadIdentity | null {
  if (identity.branch === null || !resolved.has(identity.branch)) {
    return identity
  }
  const oid = resolved.get(identity.branch) ?? null
  return oid === null ? null : { ...identity, head: oid }
}

function applyResolvedRefOids(cache: WorktreeHeadIdentityCache, resolved: ResolvedRefOids): void {
  if (resolved.size === 0) {
    return
  }
  for (const [name, identity] of cache.entries) {
    const next = retargetCachedIdentity(identity, resolved)
    if (next === null) {
      cache.entries.delete(name)
    } else if (next !== identity) {
      cache.entries.set(name, next)
    }
  }
  if (cache.primary) {
    cache.primary = retargetCachedIdentity(cache.primary, resolved)
  }
}

/** Reads head/branch for the primary checkout and every linked worktree of a
 *  Git common dir using only metadata-file reads (HEAD, gitdir, loose refs,
 *  packed-refs) — no Git subprocess. Unresolvable entries are skipped so
 *  callers never overwrite store state with partial reads.
 *
 *  Pass a `cache` plus a narrowed `scope` to re-read only the entries a watcher
 *  burst could have moved; the defaults re-read everything. */
export async function readGitCommonHeadIdentities(
  commonDirPath: string,
  cache: WorktreeHeadIdentityCache = createWorktreeHeadIdentityCache(),
  scope: WorktreeHeadIdentityScope = FULL_HEAD_IDENTITY_SCOPE
): Promise<GitCommonHeadIdentityRead> {
  let packedRefsPromise: Promise<Map<string, string> | Unreadable> | null = null
  const packedRefs = (): Promise<Map<string, string> | Unreadable> =>
    (packedRefsPromise ??= readPackedRefs(commonDirPath))
  const resolved: ResolvedRefOids = new Map()

  // Only the standard `<checkout>/.git` layout maps a common dir back to its
  // primary checkout path; bare/custom GIT_DIR layouts have no primary row.
  if (basename(commonDirPath) !== '.git') {
    cache.primary = null
  } else if (scope.all || scope.primary || cache.primary === null || cache.primaryUnverified) {
    const primary = await readHeadIdentity(
      commonDirPath,
      join(commonDirPath, 'HEAD'),
      dirname(commonDirPath),
      packedRefs,
      resolved
    )
    cache.primaryUnverified = primary === UNREADABLE
    if (primary !== UNREADABLE) {
      cache.primary = primary
    }
  }

  let entryNames = cache.entryNames
  let listingStale = false
  let relisted = false
  const relist = async (): Promise<void> => {
    relisted = true
    const listing = await listLinkedEntryNames(commonDirPath)
    if (listing === null) {
      listingStale = true
      return
    }
    listingStale = false
    entryNames = listing
    const present = new Set(listing)
    for (const name of cache.entries.keys()) {
      if (!present.has(name)) {
        cache.entries.delete(name)
      }
    }
  }
  if (entryNames === null || scope.all || scope.listing) {
    await relist()
  }
  if (entryNames === null) {
    // Unreadable on the very first pass: report only the primary and leave the
    // memo unset so the next refresh re-enumerates.
    return { identities: cache.primary ? [cache.primary] : [], complete: false }
  }

  let entryKeys = entryNames.map(headIdentityEntryKey)
  // Why: a scope naming an entry the memoized listing does not know means the
  // listing is behind, not that the entry may be skipped. Never let a named
  // entry resolve to zero work.
  if (!relisted && !knowsEveryScopedEntry(entryKeys, scope)) {
    await relist()
    entryKeys = entryNames.map(headIdentityEntryKey)
  }

  const staleNames = entryNames.filter(
    (name, index) =>
      scope.all ||
      !cache.entries.has(name) ||
      // Retried promptly: an unknown from last pass is not evidence of anything.
      cache.unverified.has(name) ||
      scope.entryNames.has(entryKeys[index])
  )
  // Bounded fan-out so a burst cannot flood the libuv threadpool; publication
  // order comes from `entryNames` below, not from completion order.
  const reads = await mapWithConcurrency(staleNames, HEAD_IDENTITY_READ_CONCURRENCY, (name) =>
    readLinkedEntryIdentity(commonDirPath, name, packedRefs, resolved)
  )
  staleNames.forEach((name, index) => {
    const identity = reads[index]
    if (identity === UNREADABLE) {
      // Unknown, not absent: keep the last verified identity and retry next pass.
      cache.unverified.add(name)
      return
    }
    cache.unverified.delete(name)
    if (identity) {
      cache.entries.set(name, identity)
    } else {
      cache.entries.delete(name)
    }
  })
  applyResolvedRefOids(cache, resolved)

  // A failed listing means the add/remove that triggered this burst is not in
  // the candidate set yet, so forget the listing rather than wait for another
  // listing event to arrive: the next refresh re-enumerates whatever its scope.
  cache.entryNames = listingStale ? null : entryNames
  const identities: WorktreeHeadIdentity[] = cache.primary ? [cache.primary] : []
  for (const name of entryNames) {
    const identity = cache.entries.get(name)
    if (identity) {
      identities.push(identity)
    }
  }
  return {
    identities,
    complete: !listingStale && cache.unverified.size === 0 && !cache.primaryUnverified
  }
}
