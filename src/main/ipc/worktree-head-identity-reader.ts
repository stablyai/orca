import { readdir, readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { WorktreeHeadIdentity } from '../../shared/worktree/types'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import {
  FULL_HEAD_IDENTITY_SCOPE,
  headIdentityEntryKey,
  type WorktreeHeadIdentityScope
} from './worktree-head-identity-scope'

// Keep refresh spawn-free: bounded metadata reads avoid Git subprocess pressure on terminal input.

const MAX_SYMREF_DEPTH = 5
// Bound parallel metadata reads without serial WSL/UNC round trips per worktree.
const HEAD_IDENTITY_READ_CONCURRENCY = 8

/** Cache scoped identities; unresolved reads must retry rather than becoming permanent misses. */
export type WorktreeHeadIdentityCache = {
  entries: Map<string, WorktreeHeadIdentity>
  /** Retain last verified identities for unreadable entries and retry them next pass. */
  unverified: Set<string>
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
  /** Incomplete listing/metadata reads cannot establish a full freshness checkpoint. */
  complete: boolean
}

/** ref → oid resolved during one pass; null means the ref no longer resolves. */
type ResolvedRefOids = Map<string, string | null>

// Unreadable is unknown, not absent: retain proven identities rather than evicting them on transient errors.
const UNREADABLE = Symbol('unreadable')
type Unreadable = typeof UNREADABLE

async function readTrimmedFile(path: string): Promise<string | null | Unreadable> {
  try {
    return (await readFile(path, 'utf8')).trim()
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : UNREADABLE
  }
}

async function readPackedRefs(commonDirPath: string): Promise<Map<string, string> | Unreadable> {
  const refs = new Map<string, string>()
  const content = await readTrimmedFile(join(commonDirPath, 'packed-refs'))
  if (content === UNREADABLE) {
    return UNREADABLE
  }
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

// Repo-authored ref names must reject Windows separators/drive syntax before joining filesystem paths.
function isSafeRefName(ref: string): boolean {
  if (ref.length === 0 || ref.includes('\\') || ref.includes(':')) {
    return false
  }
  return !ref.split('/').some((part) => part === '..' || part === '')
}

// Only SHA-1/SHA-256 object IDs may leave this reader, bounding malformed-repo output.
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
    // Unknown branch reads must not evict cached siblings sharing the branch.
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

// Transient listing failure is unknown; only a genuinely absent directory proves an empty catalog.
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

// Shared branches can move without sibling reflog events; replay resolved refs onto cached siblings, evicting unresolved ones.
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

/** Read heads without Git subprocesses; cache plus scope narrows reads while incomplete results remain explicit. */
export async function readGitCommonHeadIdentities(
  commonDirPath: string,
  cache: WorktreeHeadIdentityCache = createWorktreeHeadIdentityCache(),
  scope: WorktreeHeadIdentityScope = FULL_HEAD_IDENTITY_SCOPE
): Promise<GitCommonHeadIdentityRead> {
  let packedRefsPromise: Promise<Map<string, string> | Unreadable> | null = null
  const packedRefs = (): Promise<Map<string, string> | Unreadable> =>
    (packedRefsPromise ??= readPackedRefs(commonDirPath))
  const resolved: ResolvedRefOids = new Map()

  // Bare/custom Git directories cannot infer a primary checkout from the standard .git parent.
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
    for (const name of cache.unverified) {
      if (!present.has(name)) {
        cache.unverified.delete(name)
      }
    }
  }
  if (entryNames === null || scope.all || scope.listing) {
    await relist()
  }
  if (entryNames === null) {
    // Failed initial listing must leave the memo unset for retry.
    return { identities: cache.primary ? [cache.primary] : [], complete: false }
  }

  let entryKeys = entryNames.map(headIdentityEntryKey)
  // A named entry absent from the memo proves the listing stale, not that no work is needed.
  if (!relisted && !knowsEveryScopedEntry(entryKeys, scope)) {
    await relist()
    entryKeys = entryNames.map(headIdentityEntryKey)
  }

  const staleNames = entryNames.filter(
    (name, index) =>
      scope.all ||
      !cache.entries.has(name) ||
      cache.unverified.has(name) ||
      scope.entryNames.has(entryKeys[index])
  )
  // Bound libuv fanout; publish in listing order rather than completion order.
  const reads = await mapWithConcurrency(staleNames, HEAD_IDENTITY_READ_CONCURRENCY, (name) =>
    readLinkedEntryIdentity(commonDirPath, name, packedRefs, resolved)
  )
  staleNames.forEach((name, index) => {
    const identity = reads[index]
    if (identity === UNREADABLE) {
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

  // Forget failed listings so the next scoped refresh still re-enumerates missed additions/removals.
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
