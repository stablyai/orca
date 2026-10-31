import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../shared/execution-host'
import { isFolderRepo } from '../shared/repo-kind'
import type { Repo } from '../shared/repo-types'
import type { GitWorktreeInfo } from '../shared/worktree/types'
import { canonicalWorktreePath } from './git/worktree-path-comparison'
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
import { worktreeRemovalPathsForRepo } from './worktree-removal-table'
import { hasWorktreeCheckoutEvidence } from '../shared/git-worktree-checkout-facts'

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
  const removals = worktreeRemovalPathsForRepo(repo.id)
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
  let byPhysicalPath: Map<string, GitWorktreeInfo> | undefined
  const physicalFacts = async (physical: string): Promise<GitWorktreeInfo | undefined> => {
    const key = canonicalWorktreePath(physical)
    const direct = rawByKey.get(key)
    if (direct) {
      return direct
    }
    if (!byPhysicalPath) {
      byPhysicalPath = new Map()
      for (const row of gitWorktrees) {
        current()
        const resolved = await resolveLocalWorktreeRealpath(row.path, observationOptions)
        if (resolved) {
          byPhysicalPath.set(canonicalWorktreePath(resolved), row)
        }
      }
    }
    return byPhysicalPath.get(key)
  }
  const checkoutByPhysicalPath = new Map<string, Awaited<ReturnType<typeof readWorktreeCheckout>>>()
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
    if (states.get(path) !== 'directory') {
      throw new Error('Worktree location could not be verified')
    }
    let facts = raw
    let physicalKey: string | undefined
    if (!raw) {
      const physical = await resolveLocalWorktreeRealpath(path, observationOptions)
      if (!physical) {
        throw new Error('Worktree physical identity could not be verified')
      }
      physicalKey = canonicalWorktreePath(physical)
      facts = await physicalFacts(physical)
    }
    const checkout =
      facts && hasWorktreeCheckoutEvidence(facts)
        ? { head: facts.head, branch: facts.branch }
        : ((physicalKey ? checkoutByPhysicalPath.get(physicalKey) : undefined) ??
          (await readWorktreeCheckout(path, gitOptions, () => options.isCurrent?.() !== false)))
    current()
    if (physicalKey) {
      checkoutByPhysicalPath.set(physicalKey, checkout)
    }
    if (facts && !facts.isMainWorktree && !knownByKey.has(canonicalWorktreePath(facts.path))) {
      rows.delete(canonicalWorktreePath(facts.path))
    }
    rows.set(key, {
      ...facts,
      path,
      ...checkout,
      isBare: facts?.isBare ?? false,
      // Main is structural registration, never a transferable role of an alias.
      isMainWorktree: raw?.isMainWorktree ?? false,
      prunable: false
    })
  }
  current()
  // The encompassing mutation/inventory witness owns final validity. Removal composes afterward.
  return [...rows.values()]
}
