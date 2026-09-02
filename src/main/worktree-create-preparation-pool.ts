import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from '../shared/cross-platform-path'
import {
  WORKTREE_CREATE_PREPARATION_DIRECTORY,
  createWorktreePreparationLockReason
} from '../shared/worktree/create-preparation'
import type { AddWorktreeOptions } from './git/worktree'
import { prepareWorktreeCreateCheckout } from './git/worktree-create-preparation'
import { toHostFilesystemPath } from './host-tree-removal'
import { preparationEntryKey, preparationPathKey } from './worktree-create-preparation-claim'
import {
  cleanupStalePreparations,
  hasPendingStalePreparationCleanup,
  resetStalePreparationCleanupForTests
} from './worktree-create-preparation-stale-cleanup'
import {
  discardPreparationWithRetry,
  resetPendingPreparationDiscardsForTests,
  trackPreparationDiscard
} from './worktree-preparation-discard-retry'

export const WORKTREE_CREATE_PREPARATION_TTL_MS = 5 * 60_000
export const WORKTREE_CREATE_PREPARATION_LIMIT = 3

export type PreparationEntry = {
  key: string
  repoPath: string
  repoPathKey: string
  workspaceRoot: string
  workspaceRootKey: string
  wslDistro: string
  baseBranch: string
  canonicalBase: string
  preparedPath: string
  options: AddWorktreeOptions
  createdAt: number
  ready: Promise<void>
  expiration: NodeJS.Timeout
}

export type StartPreparationArgs = {
  repoPath: string
  workspaceRoot: string
  baseBranch: string
  canonicalBase: string
  options: AddWorktreeOptions
}

const preparations = new Map<string, PreparationEntry>()

/** One repo on one Git host: the scope a stranded discard is retried under. */
function preparationHostKey(repoPathKey: string, wslDistro: string): string {
  return `${repoPathKey}\0${wslDistro}`
}

/** A prepared checkout is a create that is either in flight or imminent. */
export function hasPendingPreparations(): boolean {
  return preparations.size > 0 || hasPendingStalePreparationCleanup()
}

function pathOps(path: string): Pick<typeof posix, 'dirname' | 'join'> {
  return isWindowsAbsolutePathLike(path) ? win32 : posix
}

async function discardEntry(entry: PreparationEntry): Promise<void> {
  // A failed checkout self-discards, but that self-discard is best-effort too, so it can strand the
  // registration for the same reason the discard here can. Enrol either way.
  await entry.ready.catch(() => {})
  await discardPreparationWithRetry({
    hostKey: preparationHostKey(entry.repoPathKey, entry.wslDistro),
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

/**
 * Frees a slot for an incoming preparation, preferring one the same workspace already owns.
 *
 * The cap is a disk bound — a prepared checkout is a full tree, ~200 MB of tracked content in the
 * repo this was measured against — so it stays small. But flipping through the composer's base
 * picker arms several preparations for one repo, and a plain oldest-first eviction let that churn
 * throw away another project's warm checkout, which is a structural miss for anyone working across
 * several repos. Evict the incoming workspace's own oldest entry first; only reach across
 * workspaces when this one holds none.
 */
function enforcePreparationLimit(
  repoPathKey: string,
  workspaceRootKey: string,
  wslDistro: string
): void {
  while (preparations.size >= WORKTREE_CREATE_PREPARATION_LIMIT) {
    const byAge = [...preparations.values()].sort((left, right) => left.createdAt - right.createdAt)
    const victim =
      byAge.find(
        (entry) =>
          entry.repoPathKey === repoPathKey &&
          entry.workspaceRootKey === workspaceRootKey &&
          entry.wslDistro === wslDistro
      ) ?? byAge[0]
    if (!victim) {
      return
    }
    preparations.delete(victim.key)
    clearTimeout(victim.expiration)
    discardEntryInBackground(victim)
  }
}

export function listPreparations(): PreparationEntry[] {
  return [...preparations.values()]
}

export function findPreparation(
  repoPathKey: string,
  workspaceRootKey: string,
  canonicalBase: string,
  wslDistro: string
): PreparationEntry | undefined {
  return preparations.get(
    preparationEntryKey(repoPathKey, workspaceRootKey, canonicalBase, wslDistro)
  )
}

/** Removes an entry from the pool so no other create can claim it. Callers must run this in the
 *  same synchronous turn as the selection that produced `entry`. */
export function takePreparation(entry: PreparationEntry): void {
  preparations.delete(entry.key)
  clearTimeout(entry.expiration)
}

export function startPreparation({
  repoPath,
  workspaceRoot,
  baseBranch,
  canonicalBase,
  options
}: StartPreparationArgs): Promise<void> {
  const repoPathKey = preparationPathKey(repoPath)
  const workspaceRootKey = preparationPathKey(workspaceRoot)
  const wslDistro = options.wslDistro ?? ''
  const key = preparationEntryKey(repoPathKey, workspaceRootKey, canonicalBase, wslDistro)
  enforcePreparationLimit(repoPathKey, workspaceRootKey, wslDistro)
  const preparationId = `${process.pid}-${randomUUID()}`
  const lockReason = createWorktreePreparationLockReason(preparationId)
  const preparationRoot = pathOps(workspaceRoot).join(
    workspaceRoot,
    WORKTREE_CREATE_PREPARATION_DIRECTORY
  )
  const preparedPath = pathOps(workspaceRoot).join(preparationRoot, preparationId)
  const entry = {} as PreparationEntry
  const expiration = setTimeout(() => expireEntry(entry), WORKTREE_CREATE_PREPARATION_TTL_MS)
  expiration.unref()
  Object.assign(entry, {
    key,
    repoPath,
    repoPathKey,
    workspaceRoot,
    workspaceRootKey,
    wslDistro,
    baseBranch,
    canonicalBase,
    preparedPath,
    options,
    createdAt: Date.now(),
    expiration,
    ready: (async () => {
      await cleanupStalePreparations(preparationHostKey(repoPathKey, wslDistro), repoPath, options)
      await mkdir(toHostFilesystemPath(preparationRoot), { recursive: true })
      // Already canonical, so the add re-resolves nothing.
      await prepareWorktreeCreateCheckout(
        repoPath,
        preparedPath,
        canonicalBase,
        lockReason,
        options
      )
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

export async function _resetPreparationPoolForTests(): Promise<void> {
  const entries = [...preparations.values()]
  preparations.clear()
  resetStalePreparationCleanupForTests()
  await Promise.all(
    entries.map(async (entry) => {
      clearTimeout(entry.expiration)
      await discardEntry(entry)
    })
  )
  await resetPendingPreparationDiscardsForTests()
}
