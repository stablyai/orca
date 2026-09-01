import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import type { Store } from './persistence'
import type { Repo } from '../shared/repo-types'
import { isFolderRepo } from '../shared/repo-kind'
import { isWindowsAbsolutePathLike } from '../shared/cross-platform-path'
import {
  WORKTREE_CREATE_PREPARATION_DIRECTORY,
  createWorktreePreparationLockReason,
  isWorktreeCreatePreparation,
  parseWorktreePreparationOwnerPid,
  parseWorktreePreparationPathOwnerPid
} from '../shared/worktree/create-preparation'
import type { AddWorktreeOptions, AddWorktreeResult } from './git/worktree'
import { listWorktreeGraph } from './git/worktree'
import {
  discardPreparedWorktree,
  finalizePreparedWorktree,
  unlockPreparedWorktree,
  prepareWorktreeCreateCheckout
} from './git/worktree-create-preparation'
import {
  getLocalProjectWorktreeGitOptions,
  getWorktreeMirrorDistro
} from './project-runtime-git-options'
import { computeWorkspaceRootAsync, getWorktreePathSettings } from './ipc/worktree-logic'
import { toHostFilesystemPath } from './host-tree-removal'
import {
  discardPreparationWithRetry,
  resetPendingPreparationDiscardsForTests,
  retryPendingPreparationDiscards,
  trackPreparationDiscard
} from './worktree-preparation-discard-retry'

export const WORKTREE_CREATE_PREPARATION_TTL_MS = 5 * 60_000
export const WORKTREE_CREATE_PREPARATION_LIMIT = 3
const STALE_PREPARATION_CLEANUP_CONCURRENCY = 4

type PreparationEntry = {
  key: string
  repoPath: string
  workspaceRoot: string
  preparedPath: string
  options: AddWorktreeOptions
  createdAt: number
  ready: Promise<void>
  expiration: NodeJS.Timeout
}

type ConsumePreparedWorktreeArgs = {
  repoPath: string
  workspaceRoot: string
  worktreePath: string
  branch: string
  baseBranch: string
  refreshLocalBaseRef?: boolean
  options?: AddWorktreeOptions
}

const preparations = new Map<string, PreparationEntry>()
const staleCleanupInFlight = new Map<string, Promise<void>>()

/** A prepared checkout is a create that is either in flight or imminent. */
export function hasPendingWorktreeCreatePreparations(): boolean {
  return preparations.size > 0 || staleCleanupInFlight.size > 0
}

function pathOps(path: string): Pick<typeof posix, 'dirname' | 'join' | 'normalize'> {
  return isWindowsAbsolutePathLike(path) ? win32 : posix
}

function pathKey(path: string): string {
  const normalized = pathOps(path).normalize(path)
  return isWindowsAbsolutePathLike(path) ? normalized.toLowerCase() : normalized
}

function preparationKey(
  repoPath: string,
  workspaceRoot: string,
  baseBranch: string,
  options: AddWorktreeOptions
): string {
  return `${pathKey(repoPath)}\0${pathKey(workspaceRoot)}\0${baseBranch}\0${options.wslDistro ?? ''}`
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function preparationHostKey(repoPath: string, options: AddWorktreeOptions): string {
  return `${pathKey(repoPath)}\0${options.wslDistro ?? ''}`
}

async function discardEntry(entry: PreparationEntry): Promise<void> {
  // A failed checkout self-discards, but that self-discard is best-effort too, so it can strand the
  // registration for the same reason the discard here can. Enrol either way.
  await entry.ready.catch(() => {})
  await discardPreparationWithRetry({
    hostKey: preparationHostKey(entry.repoPath, entry.options),
    repoPath: entry.repoPath,
    preparedPath: entry.preparedPath,
    options: entry.options
  })
}

function discardEntryInBackground(entry: PreparationEntry): void {
  // Tracked, not bare `void`: the test reset must be able to settle it before dropping the registry.
  trackPreparationDiscard(discardEntry(entry))
}

function expireEntry(entry: PreparationEntry): void {
  if (preparations.get(entry.key) !== entry) {
    return
  }
  preparations.delete(entry.key)
  discardEntryInBackground(entry)
}

function enforcePreparationLimit(): void {
  while (preparations.size >= WORKTREE_CREATE_PREPARATION_LIMIT) {
    const oldest = [...preparations.values()].sort(
      (left, right) => left.createdAt - right.createdAt
    )[0]
    if (!oldest) {
      return
    }
    preparations.delete(oldest.key)
    clearTimeout(oldest.expiration)
    discardEntryInBackground(oldest)
  }
}

async function cleanupStalePreparations(
  repoPath: string,
  options: AddWorktreeOptions
): Promise<void> {
  const cleanupKey = preparationHostKey(repoPath, options)
  const existing = staleCleanupInFlight.get(cleanupKey)
  if (existing) {
    await existing.catch(() => {})
    return
  }
  const cleanup = (async () => {
    // Not awaited: the create path awaits this cleanup, and one stranded discard costs an unlock plus
    // a `worktree remove --force` bounded at 30s each. Reclaiming leaked scratch must not delay create.
    void retryPendingPreparationDiscards(cleanupKey)
    const worktrees = await listWorktreeGraph(repoPath, {
      ...options,
      includeCreatePreparations: true
    })
    const staleWorktrees = worktrees.filter(isWorktreeCreatePreparation)
    let nextIndex = 0
    async function discardNextStalePreparation(): Promise<void> {
      while (nextIndex < staleWorktrees.length) {
        const worktree = staleWorktrees[nextIndex]
        nextIndex += 1
        const lockOwnerPid = parseWorktreePreparationOwnerPid(worktree.lockReason)
        const pathOwnerPid = parseWorktreePreparationPathOwnerPid(worktree.path)
        if (!lockOwnerPid || isProcessAlive(lockOwnerPid)) {
          continue
        }
        // Preserve a branch-attached final path after a crash; only detached or
        // still-hidden preparations are safe to discard automatically.
        if (worktree.branch && pathOwnerPid === null) {
          await unlockPreparedWorktree(repoPath, worktree.path, options).catch(() => {})
        } else if (pathOwnerPid === lockOwnerPid) {
          await discardPreparedWorktree(repoPath, worktree.path, options).catch(() => {})
        }
      }
    }
    const workerCount = Math.min(STALE_PREPARATION_CLEANUP_CONCURRENCY, staleWorktrees.length)
    await Promise.all(Array.from({ length: workerCount }, () => discardNextStalePreparation()))
  })()
  staleCleanupInFlight.set(cleanupKey, cleanup)
  try {
    await cleanup.catch(() => {})
  } finally {
    if (staleCleanupInFlight.get(cleanupKey) === cleanup) {
      staleCleanupInFlight.delete(cleanupKey)
    }
  }
}

export async function prepareWorktreeCreateForRepo(
  store: Store,
  repo: Repo,
  baseBranch: string
): Promise<void> {
  if (repo.connectionId || isFolderRepo(repo)) {
    return
  }
  const options = getLocalProjectWorktreeGitOptions(store, repo)
  // Resolving a WSL repo's root spawns `wsl.exe`, and this runs while the create composer is open,
  // so it must not block the main thread. Key lookup and insert stay in one sync run after the await.
  // The mirror distro must be threaded exactly as createLocalWorktree threads it, or the two sides
  // key on different roots and every prepared checkout is discarded.
  const workspaceRoot = await computeWorkspaceRootAsync(
    repo.path,
    getWorktreePathSettings(repo, store.getSettings(), getWorktreeMirrorDistro(store, repo))
  )
  const key = preparationKey(repo.path, workspaceRoot, baseBranch, options)
  const existing = preparations.get(key)
  if (existing) {
    return existing.ready
  }

  enforcePreparationLimit()
  const preparationId = `${process.pid}-${randomUUID()}`
  const lockReason = createWorktreePreparationLockReason(preparationId)
  const preparedPath = pathOps(workspaceRoot).join(
    workspaceRoot,
    WORKTREE_CREATE_PREPARATION_DIRECTORY,
    preparationId
  )
  const entry = {} as PreparationEntry
  const expiration = setTimeout(() => expireEntry(entry), WORKTREE_CREATE_PREPARATION_TTL_MS)
  expiration.unref()
  Object.assign(entry, {
    key,
    repoPath: repo.path,
    workspaceRoot,
    preparedPath,
    options,
    createdAt: Date.now(),
    expiration,
    ready: (async () => {
      await cleanupStalePreparations(repo.path, options)
      await mkdir(
        toHostFilesystemPath(
          pathOps(workspaceRoot).join(workspaceRoot, WORKTREE_CREATE_PREPARATION_DIRECTORY)
        ),
        { recursive: true }
      )
      await prepareWorktreeCreateCheckout(repo.path, preparedPath, baseBranch, lockReason, options)
    })()
  } satisfies PreparationEntry)
  preparations.set(key, entry)
  void entry.ready.catch(() => {
    if (preparations.get(key) === entry) {
      preparations.delete(key)
      clearTimeout(entry.expiration)
    }
  })
  return entry.ready
}

async function claimPreparedWorktree(
  repoPath: string,
  workspaceRoot: string,
  baseBranch: string,
  options: AddWorktreeOptions
): Promise<PreparationEntry | null> {
  const key = preparationKey(repoPath, workspaceRoot, baseBranch, options)
  const entry = preparations.get(key)
  if (!entry) {
    return null
  }
  preparations.delete(key)
  clearTimeout(entry.expiration)
  try {
    await entry.ready
    return entry
  } catch {
    return null
  }
}

export async function consumePreparedWorktreeCreate(
  args: ConsumePreparedWorktreeArgs
): Promise<AddWorktreeResult | null> {
  const options = args.options ?? {}
  const entry = await claimPreparedWorktree(
    args.repoPath,
    args.workspaceRoot,
    args.baseBranch,
    options
  )
  if (!entry) {
    return null
  }
  try {
    await mkdir(toHostFilesystemPath(pathOps(args.worktreePath).dirname(args.worktreePath)), {
      recursive: true
    })
    return await finalizePreparedWorktree(
      args.repoPath,
      entry.preparedPath,
      args.worktreePath,
      args.branch,
      args.baseBranch,
      args.refreshLocalBaseRef,
      options
    )
  } catch (error) {
    await discardPreparedWorktree(args.repoPath, entry.preparedPath, options).catch(() => {})
    console.warn(
      '[worktree-create] prepared checkout could not be finalized; using normal add',
      error
    )
    return null
  }
}

export async function _resetWorktreeCreatePreparationsForTests(): Promise<void> {
  const entries = [...preparations.values()]
  preparations.clear()
  staleCleanupInFlight.clear()
  await Promise.all(
    entries.map(async (entry) => {
      clearTimeout(entry.expiration)
      await discardEntry(entry)
    })
  )
  await resetPendingPreparationDiscardsForTests()
}
