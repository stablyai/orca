import { worktreePreparationGit } from '../../../git/worktrees/creation/worktree-create-git-executor'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from '../../../../shared/cross-platform-path'
import {
  WORKTREE_CREATE_PREPARATION_DIRECTORY,
  createWorktreePreparationLockReason
} from '../../../../shared/worktree/create-preparation'
import type { AddWorktreeOptions } from '../../../git/worktrees/worktree-operation-options'
import {
  prepareWorktreeCreateCheckout,
  discardPreparedWorktree
} from '../../../git/worktrees/creation/worktree-create-preparation'
import { queuePreparedWorktreeTipRefresh } from './worktree-preparation-refresh-queue'
import { toHostFilesystemPath } from '../../../filesystem/host-tree-removal'
import { createPreparationActivity } from './worktree-create-preparation-activity'
import { profileStateAccessMachineIdentity } from '../../../persistence/profile-state/profile-state-access-identity'
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

import { WorktreePreparationOperation } from '../../../git/worktrees/creation/worktree-preparation-operation'
import { waitForPromiseWithSignal } from '../../../../shared/abort-signal-reason'
export { WORKTREE_CREATE_PREPARATION_TTL_MS } from '../../../git/worktrees/creation/worktree-preparation-operation'
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
  operation: WorktreePreparationOperation
  checkoutStarted: boolean
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

export function hasPendingPreparations(): boolean {
  return preparations.size > 0 || hasClaims() || hasPendingStalePreparationCleanup()
}

function discardEntryInBackground(entry: PreparationEntry): void {
  // Let test reset await background discards before clearing the registry.
  trackPreparationDiscard(worktreePreparationGit.run(() => discardPreparationEntry(entry)))
}

function evictEntry(entry: PreparationEntry): void {
  preparations.delete(entry.key)
  entry.operation.controller.abort()
  discardEntryInBackground(entry)
}

function expireEntry(entry: PreparationEntry): void {
  if (preparations.get(entry.key) === entry) {
    evictEntry(entry)
  }
}

/** A removed project has no create left to claim its armed checkouts. */
export function discardRepoPreparations(repoPathKey: string): void {
  for (const entry of preparations.values()) {
    if (entry.repoPathKey === repoPathKey) {
      evictEntry(entry)
    }
  }
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
    evictEntry(victim)
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

/** Take synchronously after selection so concurrent creates cannot claim the same entry. */
export function takePreparation(
  entry: PreparationEntry,
  requestedCanonicalBase = entry.canonicalBase
): PreparationClaim {
  preparations.delete(entry.key)
  entry.operation.claim()
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
        entry.operation.complete()
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
  const lockReason = createWorktreePreparationLockReason(
    preparationId,
    profileStateAccessMachineIdentity()
  )
  const paths = isWindowsAbsolutePathLike(workspaceRoot) ? win32 : posix
  const preparationRoot = paths.join(workspaceRoot, WORKTREE_CREATE_PREPARATION_DIRECTORY)
  const preparedPath = paths.join(preparationRoot, preparationId)
  const operation = new WorktreePreparationOperation(options, () => expireEntry(entry))
  const signal = operation.signal
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
    operation,
    checkoutStarted: false,
    activity: createPreparationActivity(kind),
    ready: Promise.resolve()
  }
  operation.setDiscard((cleanupOptions) =>
    discardPreparedWorktree(repoPath, preparedPath, cleanupOptions, lockReason)
  )
  entry.ready = operation.run(async () => {
    await waitForPromiseWithSignal(
      startStalePreparationCleanup(preparationHostKey(repoPathKey, wslDistro), repoPath, options),
      signal
    )
    signal.throwIfAborted()
    await operation.trackWriter(mkdir(toHostFilesystemPath(preparationRoot), { recursive: true }))
    signal.throwIfAborted()
    entry.checkoutStarted = true
    await prepareWorktreeCreateCheckout(
      repoPath,
      preparedPath,
      canonicalBase,
      lockReason,
      { ...options, signal },
      beforeMaterialization,
      operation
    )
  })
  preparations.set(key, entry)
  entry.activity.track(entry.ready)
  void entry.ready.catch(() => {
    if (preparations.get(key) === entry) {
      preparations.delete(key)
      entry.operation.complete()
    }
    discardEntryInBackground(entry)
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
      entry.operation.controller.abort()
      await discardPreparationEntry(entry)
    })
  )
  await resetPendingPreparationDiscardsForTests()
}
