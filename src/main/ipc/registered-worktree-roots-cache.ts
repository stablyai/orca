import { resolve } from 'node:path'
import type { Repo } from '../../shared/repo-types'
import type { Store } from '../persistence'
import {
  listWorktreeRootsWithConcurrency,
  pruneCreatedWorktreeRoots
} from './registered-worktree-root-probes'
import { isDescendantOrEqual, normalizeExistingPath } from './filesystem-path-containment'
import {
  getLocalWorktreeRootOwners,
  resolveWorktreeRootOwner
} from './registered-worktree-root-owner'

type RegisteredOwner = {
  repoId: string
  listed: Set<string> | null
  recovered: Set<string>
  aliases: Set<string>
  revision: number
  dirty: boolean
}

const registeredWorktreeRoots = new Set<string>()
const registeredOwners = new Map<string, RegisteredOwner>()
const registeredWorktreeRootsRevisionByRepo = new Map<string, number>()
const CREATED_WORKTREE_ROOTS_MAX = 64
let revisionSequence = 0
let baseRevision = 0
let invalidationGeneration = 0
let registryStore: Store | null = null
let currentOwners = new Map<string, Repo>()
let registeredWorktreeRootsDirty = true
let registeredWorktreeRootsRefresh: Promise<void> | null = null

function advanceOwner(owner: RegisteredOwner): void {
  owner.revision = ++revisionSequence
  owner.aliases.clear()
  registeredWorktreeRootsRevisionByRepo.set(owner.repoId, owner.revision)
}

function synchronizeOwners(store: Store): Repo[] {
  const repos = store.getRepos()
  const owners = getLocalWorktreeRootOwners(repos)
  if (registryStore !== store) {
    registeredOwners.clear()
    registryStore = store
    invalidationGeneration++
  }
  let changed = currentOwners.size !== owners.size
  for (const [key, owner] of registeredOwners) {
    if (!owners.has(key)) {
      advanceOwner(owner)
      registeredOwners.delete(key)
      changed = true
    }
  }
  for (const [key, repo] of owners) {
    if (!registeredOwners.has(key)) {
      registeredOwners.set(key, {
        repoId: repo.id,
        listed: null,
        recovered: new Set(),
        aliases: new Set(),
        revision: ++revisionSequence,
        dirty: true
      })
      changed = true
    }
  }
  currentOwners = owners
  if (changed) {
    refreshRegisteredWorktreeRoots()
  }
  registeredWorktreeRootsDirty = [...registeredOwners.values()].some((owner) => owner.dirty)
  return repos
}

export function invalidateAuthorizedRootsCache(): void {
  invalidationGeneration++
  for (const owner of registeredOwners.values()) {
    owner.listed = null
    owner.dirty = true
    advanceOwner(owner)
  }
  refreshRegisteredWorktreeRoots()
  registeredWorktreeRootsDirty = true
  baseRevision = ++revisionSequence
  registeredWorktreeRootsRevisionByRepo.clear()
}

export async function rebuildAuthorizedRootsCache(store: Store): Promise<void> {
  synchronizeOwners(store)
  const generation = invalidationGeneration
  const pending = [...currentOwners].map(([key, repo]) => ({
    key,
    repo,
    owner: registeredOwners.get(key),
    revision: registeredOwners.get(key)?.revision
  }))
  const listings = await listWorktreeRootsWithConcurrency(pending.map((entry) => entry.repo))
  const results = pending.map((entry, index) => ({ ...entry, ...listings[index] }))
  const isCurrent = (entry: (typeof pending)[number]): boolean =>
    generation === invalidationGeneration &&
    registeredOwners.get(entry.key) === entry.owner &&
    entry.owner?.revision === entry.revision
  synchronizeOwners(store)
  const pruned = await Promise.all(
    results.map(async (entry) => {
      if (!entry.owner || !isCurrent(entry)) {
        return null
      }
      const recovered = await pruneCreatedWorktreeRoots(entry.owner.recovered, entry)
      return { ...entry, recovered }
    })
  )
  synchronizeOwners(store)
  for (const entry of pruned) {
    // A fresh create or ownership change makes both the graph and absence probes obsolete.
    if (!entry || !entry.owner || !isCurrent(entry)) {
      continue
    }
    entry.owner.listed = entry.roots
    entry.owner.dirty = false
    entry.owner.recovered = entry.recovered
    advanceOwner(entry.owner)
  }
  refreshRegisteredWorktreeRoots()
  registeredWorktreeRootsDirty = [...registeredOwners.values()].some((owner) => owner.dirty)
}

export function registerWorktreeRootsForRepo(
  store: Store,
  repo: Repo | string,
  worktreeRoots: string[]
): void {
  const repos = synchronizeOwners(store)
  const key = resolveWorktreeRootOwner(repos, repo, currentOwners)
  const owner = key === undefined ? undefined : registeredOwners.get(key)
  if (!owner) {
    return
  }
  owner.listed = new Set(worktreeRoots.map((root) => resolve(root)))
  owner.dirty = false
  advanceOwner(owner)
  refreshRegisteredWorktreeRoots()
  registeredWorktreeRootsDirty = [...registeredOwners.values()].some((entry) => entry.dirty)
}

/** Preserve directly confirmed creates when an unavailable listing cannot name them. */
export function registerCreatedWorktreeRoot(
  store: Store,
  repo: Repo | string,
  worktreeRoot: string
): void {
  const repos = synchronizeOwners(store)
  const key = resolveWorktreeRootOwner(repos, repo, currentOwners)
  const owner = key === undefined ? undefined : registeredOwners.get(key)
  if (!owner) {
    return
  }
  const root = resolve(worktreeRoot)
  if (!owner.recovered.has(root) && owner.recovered.size >= CREATED_WORKTREE_ROOTS_MAX) {
    console.warn(
      `[filesystem-auth] recovered-root layer full for repo ${owner.repoId}; not authorizing ${root}`
    )
    return
  }
  owner.recovered.add(root)
  owner.dirty = true
  advanceOwner(owner)
  refreshRegisteredWorktreeRoots()
  registeredWorktreeRootsDirty = true
}

export function __resetCreatedWorktreeRootsForTests(): void {
  for (const owner of registeredOwners.values()) {
    owner.recovered.clear()
    advanceOwner(owner)
  }
  refreshRegisteredWorktreeRoots()
}

export function getRegisteredWorktreeRootsRevision(repoId: string): number {
  return registeredWorktreeRootsRevisionByRepo.get(repoId) ?? baseRevision
}

export async function ensureAuthorizedRootsCache(store: Store): Promise<void> {
  synchronizeOwners(store)
  // Follow one superseded refresh; continuous catalog churn must not pin authorization forever.
  for (let attempt = 0; registeredWorktreeRootsDirty && attempt < 2; attempt++) {
    if (!registeredWorktreeRootsRefresh) {
      registeredWorktreeRootsRefresh = rebuildAuthorizedRootsCache(store).finally(() => {
        registeredWorktreeRootsRefresh = null
      })
    }
    await registeredWorktreeRootsRefresh
  }
}

export async function resolveRegisteredWorktreePath(
  worktreePath: string,
  store: Store
): Promise<string> {
  if (!worktreePath || worktreePath.includes('\0')) {
    throw new Error('Access denied: invalid worktree path')
  }
  synchronizeOwners(store)
  const resolvedTarget = resolve(worktreePath)
  if (
    registeredWorktreeRoots.has(resolvedTarget) ||
    [...currentOwners.values()].some((repo) => resolve(repo.path) === resolvedTarget)
  ) {
    return resolvedTarget
  }
  await ensureAuthorizedRootsCache(store)
  if (registeredWorktreeRoots.has(resolvedTarget)) {
    return resolvedTarget
  }
  const normalizedTarget = await normalizeExistingPath(resolvedTarget)
  synchronizeOwners(store)
  if (registeredWorktreeRoots.has(normalizedTarget)) {
    return normalizedTarget
  }
  throw new Error('Access denied: unknown repository or worktree path')
}

function refreshRegisteredWorktreeRoots(): void {
  registeredWorktreeRoots.clear()
  for (const owner of registeredOwners.values()) {
    for (const roots of [owner.listed, owner.recovered, owner.aliases]) {
      if (roots) {
        for (const root of roots) {
          registeredWorktreeRoots.add(root)
        }
      }
    }
  }
}

export function isRegisteredWorktreePath(targetPath: string, store: Store): boolean {
  synchronizeOwners(store)
  for (const root of registeredWorktreeRoots) {
    if (isDescendantOrEqual(targetPath, root)) {
      return true
    }
  }
  return false
}

export async function isPathAllowedByCanonicalRegisteredRoot(
  targetPath: string,
  sourcePath: string | undefined,
  store: Store
): Promise<boolean> {
  if (!sourcePath) {
    return false
  }
  synchronizeOwners(store)
  const textualRoot = findRegisteredWorktreeRoot(sourcePath)
  if (!textualRoot) {
    return false
  }
  const generation = invalidationGeneration
  const owners = [...registeredOwners.values()]
    .filter(
      (owner) =>
        owner.listed?.has(textualRoot) ||
        owner.recovered.has(textualRoot) ||
        owner.aliases.has(textualRoot)
    )
    .map((owner) => ({ owner, revision: owner.revision }))
  const canonicalRoot = await normalizeExistingPath(textualRoot)
  synchronizeOwners(store)
  if (generation !== invalidationGeneration || !isDescendantOrEqual(targetPath, canonicalRoot)) {
    return false
  }
  let allowed = false
  for (const { owner, revision } of owners) {
    if (owner.revision !== revision) {
      continue
    }
    owner.aliases.add(canonicalRoot)
    allowed = true
  }
  if (allowed) {
    registeredWorktreeRoots.add(canonicalRoot)
  }
  return allowed
}

function findRegisteredWorktreeRoot(targetPath: string): string | null {
  let bestRoot: string | null = null
  for (const root of registeredWorktreeRoots) {
    if (isDescendantOrEqual(targetPath, root) && (!bestRoot || root.length > bestRoot.length)) {
      bestRoot = root
    }
  }
  return bestRoot
}
