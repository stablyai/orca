import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../shared/execution-host'
import { isFolderRepo } from '../shared/repo-kind'
import type { Repo } from '../shared/repo-types'
import type { GitWorktreeInfo } from '../shared/worktree/types'
import { areWorktreePathsEqual, canonicalWorktreePath } from './git/worktree-path-comparison'
import { readWorktreeCheckout } from './git/worktree-checkout-observation'
import { posix, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from '../shared/cross-platform-path'
import { throwIfSignalAborted } from '../shared/abort-signal-reason'
import type { GitWorktreeExecOptions } from './git/worktree-operation-options'
import {
  inspectLocalWorktreeDirectory,
  resolveLocalWorktreeRealpath
} from './local-worktree-path-presence'
import type { KnownWorktreePath, RepoWorktreeInventory } from './known-worktree-inventory'
import { knownWorktreeInventory, type WorktreeInventoryStore } from './known-worktree-inventory'
import { failedWorktreeRemovals, pendingWorktreeRemovals } from './worktree-removal-table'

export class KnownWorktreeListingError extends Error {
  constructor(cause: unknown) {
    super(
      'Saved worktrees could not be verified; retry the listing when their location is available.',
      { cause }
    )
  }
}

function pickKnownSpelling(listedPath: string, spellings: KnownWorktreePath[]): string {
  const withSession = spellings.filter((spelling) => spelling.hasSession)
  const candidates = withSession.length > 0 ? withSession : spellings
  return (candidates.find((spelling) => spelling.path === listedPath) ?? candidates[0]).path
}

function removalPaths(repo: Repo): Set<string> {
  const paths = new Set<string>()
  for (const table of [pendingWorktreeRemovals, failedWorktreeRemovals]) {
    for (const record of table.values()) {
      if (record.repoId === repo.id) {
        paths.add(canonicalWorktreePath(record.worktreePath))
      }
    }
  }
  return paths
}

/** Reconcile published membership, physical identity and checkout facts without inventing unknown facts. */
export async function retainKnownWorktreesInListing(
  store: WorktreeInventoryStore,
  repo: Repo,
  gitWorktrees: GitWorktreeInfo[],
  options: {
    gitOptions: GitWorktreeExecOptions
    inventory?: RepoWorktreeInventory
    signal?: AbortSignal
    isCurrent?: () => boolean
  }
): Promise<GitWorktreeInfo[]> {
  if (getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID || isFolderRepo(repo)) {
    return gitWorktrees
  }
  try {
    return await reconcileKnownWorktrees(store, repo, gitWorktrees, options)
  } catch (cause) {
    throw new KnownWorktreeListingError(cause)
  }
}

async function reconcileKnownWorktrees(
  store: WorktreeInventoryStore,
  repo: Repo,
  gitWorktrees: GitWorktreeInfo[],
  options: {
    gitOptions: GitWorktreeExecOptions
    inventory?: RepoWorktreeInventory
    signal?: AbortSignal
    isCurrent?: () => boolean
  }
): Promise<GitWorktreeInfo[]> {
  const current = (): void => {
    throwIfSignalAborted(options.signal)
    if (options.isCurrent?.() === false) {
      throw new Error('Worktree observation superseded')
    }
  }
  current()
  const known = (options.inventory ?? knownWorktreeInventory(store).read(repo)).paths
  if (known.length === 0) {
    return gitWorktrees
  }
  const knownByKey = new Map<string, KnownWorktreePath[]>()
  for (const spelling of known) {
    const key = canonicalWorktreePath(spelling.path)
    const spellings = knownByKey.get(key) ?? []
    spellings.push(spelling)
    knownByKey.set(key, spellings)
  }
  const rawByKey = new Map(gitWorktrees.map((row) => [canonicalWorktreePath(row.path), row]))
  const listed = gitWorktrees.map((row) => {
    const spellings = knownByKey.get(canonicalWorktreePath(row.path))
    const path = spellings ? pickKnownSpelling(row.path, spellings) : row.path
    return path === row.path ? row : { ...row, path }
  })
  const unmatched = [...knownByKey.entries()]
    .filter(([key]) => {
      const raw = rawByKey.get(key)
      return !raw || (raw.prunable && !raw.removalError)
    })
    .map(([, spellings]) => pickKnownSpelling('', spellings))
  if (unmatched.length === 0) {
    return listed
  }
  const removals = removalPaths(repo)
  const candidates = unmatched.filter((path) => !removals.has(canonicalWorktreePath(path)))
  if (candidates.length === 0) {
    return listed
  }
  if (!gitWorktrees.some((row) => row.isMainWorktree)) {
    throw new Error('Incomplete worktree listing')
  }
  const gitOptions = { ...options.gitOptions, signal: options.signal }
  const observationOptions = { ...gitOptions, isCurrent: options.isCurrent }
  const states = new Map<string, Awaited<ReturnType<typeof inspectLocalWorktreeDirectory>>>()
  for (const path of candidates) {
    current()
    states.set(path, await inspectLocalWorktreeDirectory(path, observationOptions))
  }
  // All child absences precede this pass's shared availability phase. Never borrow a prior pass's probe.
  const locations = new Map<string, Awaited<ReturnType<typeof inspectLocalWorktreeDirectory>>>()
  for (const path of candidates) {
    if (states.get(path) !== 'missing') {
      continue
    }
    const parent = (isWindowsAbsolutePathLike(path) ? win32 : posix).dirname(path)
    for (const location of [repo.path, parent]) {
      if (!locations.has(location)) {
        locations.set(location, await inspectLocalWorktreeDirectory(location, observationOptions))
      }
    }
  }
  const rows = new Map(listed.map((row) => [canonicalWorktreePath(row.path), row]))
  const byPhysicalPath = new Map<string, string>()
  if (candidates.some((path) => !rawByKey.has(canonicalWorktreePath(path)))) {
    for (const [key, row] of rows) {
      current()
      const physical = await resolveLocalWorktreeRealpath(row.path, observationOptions)
      if (physical) {
        byPhysicalPath.set(canonicalWorktreePath(physical), key)
      }
    }
  }
  for (const path of candidates) {
    current()
    const key = canonicalWorktreePath(path)
    const raw = rawByKey.get(key)
    const parent = (isWindowsAbsolutePathLike(path) ? win32 : posix).dirname(path)
    if (
      states.get(path) === 'missing' &&
      locations.get(repo.path) === 'directory' &&
      locations.get(parent) === 'directory'
    ) {
      rows.delete(key)
      continue
    }
    let aliasKey: string | undefined
    if (!raw && states.get(path) === 'directory') {
      const physical = await resolveLocalWorktreeRealpath(path, observationOptions)
      if (!physical) {
        throw new Error('Worktree physical identity could not be verified')
      }
      aliasKey = byPhysicalPath.get(canonicalWorktreePath(physical))
    }
    const facts = raw ?? (aliasKey ? rows.get(aliasKey) : undefined)
    const checkout = facts?.head
      ? { head: facts.head, branch: facts.branch }
      : await readWorktreeCheckout(path, gitOptions, () => options.isCurrent?.() !== false)
    current()
    if (aliasKey) {
      rows.delete(aliasKey)
    }
    rows.set(key, {
      ...facts,
      path,
      ...checkout,
      isBare: false,
      isMainWorktree: facts?.isMainWorktree ?? areWorktreePathsEqual(path, repo.path),
      prunable: false
    })
  }
  current()
  // The encompassing mutation/inventory witness owns final validity. Removal composes afterward.
  return [...rows.values()]
}
