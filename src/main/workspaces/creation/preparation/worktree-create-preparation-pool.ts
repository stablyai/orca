import { discardUnmaterializedPreparation } from '../../../git/worktrees/creation/worktree-preparation-add'
import {
  cancelPreparationAdmissions,
  waitForPreparationAdmission,
  canPrepare,
  selectPreparationVictim,
  type StartPreparationArgs
} from './worktree-preparation-admission-intents'
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
import { prepareWorktreeCreateCheckout } from '../../../git/worktrees/creation/worktree-create-preparation'
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
  preparationCapacityUsed,
  registerPreparationObligation,
  retryPendingPreparationDiscards,
  resetPendingPreparationDiscardsForTests,
  trackPreparationDiscard
} from './worktree-preparation-discard-retry'

import { WorktreePreparationOperation } from '../../../git/worktrees/creation/worktree-preparation-operation'
import { waitForPromiseWithSignal } from '../../../../shared/abort-signal-reason'
export type { StartPreparationArgs } from './worktree-preparation-admission-intents'
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

const preparations = new Map<string, PreparationEntry>()

export function hasPendingPreparations(): boolean {
  return preparations.size > 0 || hasClaims() || hasPendingStalePreparationCleanup()
}

function discardEntryInBackground(entry: PreparationEntry): Promise<void> {
  const work = worktreePreparationGit.run(() => discardPreparationEntry(entry))
  trackPreparationDiscard(work)
  return work
}

function evictEntry(entry: PreparationEntry): Promise<void> {
  preparations.delete(entry.key)
  entry.operation.controller.abort()
  return discardEntryInBackground(entry)
}

function expireEntry(entry: PreparationEntry): void {
  if (preparations.get(entry.key) === entry) {
    evictEntry(entry)
  }
}

/** A removed project has no create left to claim its armed checkouts. */
export function discardRepoPreparations(repoPathKey: string): void {
  cancelPreparationAdmissions(repoPathKey)
  for (const entry of preparations.values()) {
    if (entry.repoPathKey === repoPathKey) {
      evictEntry(entry)
    }
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

function reusePreparation(
  args: StartPreparationArgs,
  kind: DeferredPreparation['kind']
): Promise<void> | undefined {
  if (!canPrepare(args)) {
    return Promise.resolve()
  }
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
  return deferPreparationForClaim(args, kind) ? Promise.resolve() : undefined
}

export function startPreparation(
  args: StartPreparationArgs,
  kind: DeferredPreparation['kind'] = 'explicit'
): Promise<void> {
  const full = preparationCapacityUsed() >= WORKTREE_CREATE_PREPARATION_LIMIT
  const retries = retryPendingPreparationDiscards(
    full
      ? undefined
      : preparationHostKey(preparationPathKey(args.repoPath), args.options.wslDistro ?? '')
  )
  void retries.catch((error) =>
    console.warn('[worktree-create] preparation cleanup retry failed', error)
  )
  const reused = reusePreparation(args, kind)
  if (reused) {
    return reused
  }
  if (!full) {
    return worktreePreparationGit.run(() => startBackgroundPreparation({ ...args, kind }))
  }
  return worktreePreparationGit.run(() =>
    waitForPreparationAdmission(args, kind, WORKTREE_CREATE_PREPARATION_LIMIT, {
      retry: retries,
      reuse: reusePreparation,
      hasCapacity: () => preparationCapacityUsed() < WORKTREE_CREATE_PREPARATION_LIMIT,
      evict: (request) => {
        const victim = selectPreparationVictim(preparations.values(), request)
        return victim ? evictEntry(victim) : undefined
      },
      start: (request, requestedKind) =>
        startBackgroundPreparation({ ...request, kind: requestedKind })
    })
  )
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

function startBackgroundPreparation(
  args: StartPreparationArgs & { kind: DeferredPreparation['kind'] }
): Promise<void> {
  const {
    repoPath,
    workspaceRoot,
    baseBranch,
    canonicalBase,
    options,
    beforeMaterialization,
    kind
  } = args
  const repoPathKey = preparationPathKey(repoPath)
  const workspaceRootKey = preparationPathKey(workspaceRoot)
  const wslDistro = options.wslDistro ?? ''
  const key = preparationEntryKey(repoPathKey, workspaceRootKey, canonicalBase, wslDistro)
  if (!canPrepare(args) || preparationCapacityUsed() >= WORKTREE_CREATE_PREPARATION_LIMIT) {
    return Promise.resolve()
  }
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
    checkoutStarted: true,
    activity: createPreparationActivity(kind),
    ready: Promise.resolve()
  }
  operation.setDiscard((cleanupOptions) =>
    discardUnmaterializedPreparation(preparedPath, cleanupOptions)
  )
  registerPreparationObligation(entry)
  entry.ready = operation.run(async () => {
    await waitForPromiseWithSignal(
      startStalePreparationCleanup(preparationHostKey(repoPathKey, wslDistro), repoPath, options),
      signal
    )
    signal.throwIfAborted()
    await operation.trackWriter(mkdir(toHostFilesystemPath(preparationRoot), { recursive: true }))
    signal.throwIfAborted()
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
  cancelPreparationAdmissions()
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
