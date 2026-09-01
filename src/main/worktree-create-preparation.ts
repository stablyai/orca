import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import type { Store } from './persistence'
import type { Repo } from '../shared/repo-types'
import { isFolderRepo } from '../shared/repo-kind'
import { isWindowsAbsolutePathLike } from '../shared/cross-platform-path'
import {
  WORKTREE_CREATE_PREPARATION_DIRECTORY,
  createWorktreePreparationLockReason
} from '../shared/worktree/create-preparation'
import type { AddWorktreeOptions, AddWorktreeResult } from './git/worktree'
import {
  discardPreparedWorktree,
  finalizePreparedWorktree,
  prepareWorktreeCreateCheckout
} from './git/worktree-create-preparation'
import {
  getLocalProjectWorktreeGitOptions,
  getWorktreeMirrorDistro
} from './project-runtime-git-options'
import { computeWorkspaceRootAsync, getWorktreePathSettings } from './ipc/worktree-logic'
import {
  recordPreparationConsume,
  resetPreparationConsumeHistoryForTests
} from './worktree-create-preparation-burst'
import {
  cleanupStalePreparations,
  resetStalePreparationCleanupForTests
} from './worktree-create-preparation-stale-cleanup'
import { toHostFilesystemPath } from './host-tree-removal'
import {
  discardPreparationWithRetry,
  resetPendingPreparationDiscardsForTests,
  trackPreparationDiscard
} from './worktree-preparation-discard-retry'

export const WORKTREE_CREATE_PREPARATION_TTL_MS = 5 * 60_000
export const WORKTREE_CREATE_PREPARATION_LIMIT = 3

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

  return startPreparation(key, repo.path, workspaceRoot, baseBranch, options)
}

function startPreparation(
  key: string,
  repoPath: string,
  workspaceRoot: string,
  baseBranch: string,
  options: AddWorktreeOptions
): Promise<void> {
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
    repoPath,
    workspaceRoot,
    preparedPath,
    options,
    createdAt: Date.now(),
    expiration,
    ready: (async () => {
      await cleanupStalePreparations(preparationHostKey(repoPath, options), repoPath, options)
      await mkdir(
        toHostFilesystemPath(
          pathOps(workspaceRoot).join(workspaceRoot, WORKTREE_CREATE_PREPARATION_DIRECTORY)
        ),
        { recursive: true }
      )
      await prepareWorktreeCreateCheckout(repoPath, preparedPath, baseBranch, lockReason, options)
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

/** Replaces a just-consumed preparation, but only once the user has shown they are creating in a
 *  burst. A replacement costs a full checkout and ~5 minutes of disk until its TTL, so arming one
 *  after an isolated create spends that on nobody. Never awaited: create has already returned by
 *  the time the replacement checkout finishes. */
function rearmPreparation(entry: PreparationEntry, baseBranch: string): void {
  // Record first: a prefetch that re-armed this key while we finalized would otherwise swallow the
  // consume, and the next create would look isolated when it is really the middle of a burst.
  const continuesBurst = recordPreparationConsume(entry.key)
  if (preparations.has(entry.key) || !continuesBurst) {
    return
  }
  void startPreparation(
    entry.key,
    entry.repoPath,
    entry.workspaceRoot,
    baseBranch,
    entry.options
  ).catch(() => {
    // Why: a warm-up failure is recovered by the normal add on the next create.
  })
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
    const result = await finalizePreparedWorktree(
      args.repoPath,
      entry.preparedPath,
      args.worktreePath,
      args.branch,
      args.baseBranch,
      args.refreshLocalBaseRef,
      options
    )
    // Consuming the only prepared checkout leaves the next create cold. Re-arm for a user who is
    // creating in a burst; the TTL and the preparation limit still bound an unused replacement.
    rearmPreparation(entry, args.baseBranch)
    return result
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
  resetPreparationConsumeHistoryForTests()
  resetStalePreparationCleanupForTests()
  await Promise.all(
    entries.map(async (entry) => {
      clearTimeout(entry.expiration)
      await discardEntry(entry)
    })
  )
  await resetPendingPreparationDiscardsForTests()
}
