import { worktreePreparationGit } from './git/worktree-create-git-executor'
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
import { WorktreePreparationLockOwnershipError } from './git/worktree-preparation-lock'
import { queuePreparedWorktreeTipRefresh } from './worktree-preparation-refresh-queue'
import { toHostFilesystemPath } from './host-tree-removal'
import { createPreparationActivity } from './worktree-create-preparation-activity'
import type { PreparationActivity } from './worktree-create-preparation-activity'
import {
  deferPreparationForClaim,
  hasClaims,
  isClaimed,
  registerClaim,
  resetClaimsForTests,
  type DeferredPreparation,
  type PreparationClaim
} from './worktree-create-preparation-claim-registry'
import { preparationEntryKey, preparationPathKey } from './worktree-create-preparation-claim'
import {
  startStalePreparationCleanup,
  hasPendingStalePreparationCleanup,
  resetStalePreparationCleanupForTests
} from './worktree-create-preparation-stale-cleanup'
import {
  discardPreparationEntry,
  preparationHostKey,
  resetPendingPreparationDiscardsForTests,
  trackPreparationDiscard
} from './worktree-preparation-discard-retry'

export {
  releasePreparationClaim,
  type DeferredPreparation,
  type PreparationClaim
} from './worktree-create-preparation-claim-registry'

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
  lockReason: string
  options: AddWorktreeOptions
  createdAt: number
  ready: Promise<void>
  expiration: NodeJS.Timeout
  controller: AbortController
  checkoutStarted: boolean
  /** Origin, disk work and timing reported by the create that uses it. */
  activity: PreparationActivity
}

export type StartPreparationArgs = {
  repoPath: string
  workspaceRoot: string
  baseBranch: string
  canonicalBase: string
  options: AddWorktreeOptions
  beforeMaterialization?: Promise<void>
}

const preparations = new Map<string, PreparationEntry>()

/** A prepared checkout is a create that is either in flight or imminent. */
export function hasPendingPreparations(): boolean {
  return preparations.size > 0 || hasClaims() || hasPendingStalePreparationCleanup()
}

function discardEntryInBackground(entry: PreparationEntry): void {
  // Tracked, not bare `void`: the test reset must be able to settle it before dropping the registry.
  trackPreparationDiscard(worktreePreparationGit.run(() => discardPreparationEntry(entry)))
}

function expireEntry(entry: PreparationEntry): void {
  if (preparations.get(entry.key) !== entry) {
    return
  }
  preparations.delete(entry.key)
  entry.controller.abort()
  discardEntryInBackground(entry)
}

/** Bound full-checkout disk use, evicting the requesting workspace's oldest preparation first. */
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
    victim.controller.abort()
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
export function takePreparation(
  entry: PreparationEntry,
  requestedCanonicalBase = entry.canonicalBase
): PreparationClaim {
  preparations.delete(entry.key)
  clearTimeout(entry.expiration)
  const requestedKey = preparationEntryKey(
    entry.repoPathKey,
    entry.workspaceRootKey,
    requestedCanonicalBase,
    entry.wslDistro
  )
  return registerClaim(entry, requestedKey)
}

export function startPreparation(
  args: StartPreparationArgs,
  kind: DeferredPreparation['kind'] = 'explicit'
): Promise<void> {
  const existing = findPreparation(
    preparationPathKey(args.repoPath),
    preparationPathKey(args.workspaceRoot),
    args.canonicalBase,
    args.options.wslDistro ?? ''
  )
  if (existing) {
    if (kind === 'explicit') {
      existing.activity.requestedByPrefetch()
    }
    return args.beforeMaterialization
      ? refreshPreparationTip(existing, args.beforeMaterialization)
      : existing.ready
  }
  if (deferPreparationForClaim(args, kind)) {
    return Promise.resolve()
  }
  return worktreePreparationGit.run(() => startBackgroundPreparation({ ...args, kind }))
}

function refreshPreparationTip(
  entry: PreparationEntry,
  beforeMaterialization: Promise<void>
): Promise<void> {
  const ready = queuePreparedWorktreeTipRefresh(
    entry,
    () => {
      const available = preparations.get(entry.key) === entry
      if (!available && !isClaimed(entry)) {
        return
      }
      if (available) {
        preparations.delete(entry.key)
        clearTimeout(entry.expiration)
      }
      discardEntryInBackground(entry)
    },
    beforeMaterialization
  )
  entry.activity.track(ready)
  return ready
}

function startBackgroundPreparation({
  repoPath,
  workspaceRoot,
  baseBranch,
  canonicalBase,
  options,
  beforeMaterialization,
  kind
}: StartPreparationArgs & { kind: DeferredPreparation['kind'] }): Promise<void> {
  const repoPathKey = preparationPathKey(repoPath)
  const workspaceRootKey = preparationPathKey(workspaceRoot)
  const wslDistro = options.wslDistro ?? ''
  const key = preparationEntryKey(repoPathKey, workspaceRootKey, canonicalBase, wslDistro)
  enforcePreparationLimit(repoPathKey, workspaceRootKey, wslDistro)
  const preparationId = `${process.pid}-${randomUUID()}`
  const lockReason = createWorktreePreparationLockReason(preparationId)
  const paths = isWindowsAbsolutePathLike(workspaceRoot) ? win32 : posix
  const preparationRoot = paths.join(workspaceRoot, WORKTREE_CREATE_PREPARATION_DIRECTORY)
  const preparedPath = paths.join(preparationRoot, preparationId)
  const controller = new AbortController()
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal
  const expiration = setTimeout(() => expireEntry(entry), WORKTREE_CREATE_PREPARATION_TTL_MS)
  expiration.unref()
  const entry: PreparationEntry = {
    key,
    repoPath,
    repoPathKey,
    workspaceRoot,
    workspaceRootKey,
    wslDistro,
    baseBranch,
    canonicalBase,
    preparedPath,
    lockReason,
    options,
    createdAt: Date.now(),
    expiration,
    controller,
    checkoutStarted: false,
    activity: createPreparationActivity(kind),
    ready: Promise.resolve()
  }
  entry.ready = (async () => {
    await startStalePreparationCleanup(
      preparationHostKey(repoPathKey, wslDistro),
      repoPath,
      options
    )
    signal.throwIfAborted()
    await mkdir(toHostFilesystemPath(preparationRoot), { recursive: true })
    signal.throwIfAborted()
    // Already canonical, so the add re-resolves nothing.
    entry.checkoutStarted = true
    try {
      await prepareWorktreeCreateCheckout(
        repoPath,
        preparedPath,
        canonicalBase,
        lockReason,
        { ...options, signal },
        beforeMaterialization
      )
    } catch (error) {
      if (error instanceof WorktreePreparationLockOwnershipError) {
        entry.checkoutStarted = false
      }
      throw error
    }
  })()
  preparations.set(key, entry)
  entry.activity.track(entry.ready)
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
  resetClaimsForTests()
  await resetStalePreparationCleanupForTests()
  await Promise.all(
    entries.map(async (entry) => {
      clearTimeout(entry.expiration)
      await discardPreparationEntry(entry)
    })
  )
  await resetPendingPreparationDiscardsForTests()
}
