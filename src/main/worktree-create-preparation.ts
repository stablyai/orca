import { worktreePreparationGit } from './git/worktree-create-git-executor'
import { mkdir } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import type { Store } from './persistence'
import type { Repo } from '../shared/repo-types'
import { isFolderRepo } from '../shared/repo-kind'
import { isWindowsAbsolutePathLike } from '../shared/cross-platform-path'
import type {
  PreparedCheckoutMissReason,
  PreparedCheckoutOrigin,
  PreparedCheckoutReset
} from '../shared/worktree/create-types'
import type { WorktreeCreatePhase } from '../shared/worktree/create-timing-vocabulary'
import type { AddWorktreeOptions, AddWorktreeResult } from './git/worktree'
import { WorktreePreparationLockOwnershipError } from './git/worktree-preparation-lock'
import {
  _resetPreparationPoolForTests,
  hasPendingPreparations,
  releasePreparationClaim,
  startPreparation,
  type DeferredPreparation,
  type PreparationClaim,
  type PreparationEntry
} from './worktree-create-preparation-pool'
import {
  canonicalBaseRef,
  reservePreparation,
  type ReservedPreparation
} from './worktree-create-preparation-reservation'
import {
  discardPreparedWorktree,
  finalizePreparedWorktree
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
import { toHostFilesystemPath } from './host-tree-removal'
import type { WorktreeCreateTimingRecorder } from './worktree-create-timing'

export {
  WORKTREE_CREATE_PREPARATION_LIMIT,
  WORKTREE_CREATE_PREPARATION_TTL_MS
} from './worktree-create-preparation-pool'

/** A prepared checkout is a create that is either in flight or imminent. */
export function hasPendingWorktreeCreatePreparations(): boolean {
  return hasPendingPreparations()
}

/** Carries the consumed slot's pending re-arm to the create's outermost `finally`, which fires it
 *  once — after startup on success, and on any failure that follows the consume. */
export type PreparationRearmHolder = { fire: () => void }

export type PreparedWorktreeCreateAttempt =
  | {
      status: 'hit'
      retargeted: boolean
      reset: PreparedCheckoutReset
      origin: PreparedCheckoutOrigin
      buildMs: number
      idleMs: number
      result: AddWorktreeResult
      /** Run after materialization/startup completes, before returning the create result. */
      rearm: () => void
    }
  | { status: 'miss'; reason: PreparedCheckoutMissReason; rearm?: () => void }

type ConsumePreparedWorktreeArgs = {
  repoPath: string
  workspaceRoot: string
  worktreePath: string
  branch: string
  baseBranch: string
  refreshLocalBaseRef?: boolean
  options?: AddWorktreeOptions
  timing?: Pick<
    WorktreeCreateTimingRecorder,
    'time' | 'recordPreparedCheckout' | 'recordAdoptedPreparation'
  >
}

function timePhase<T>(
  args: ConsumePreparedWorktreeArgs,
  phase: WorktreeCreatePhase,
  operation: () => Promise<T>
): Promise<T> {
  return args.timing ? args.timing.time(phase, operation) : operation()
}

export function prepareWorktreeCreateForRepo(
  store: Store,
  repo: Repo,
  baseBranch: string,
  beforeMaterialization?: Promise<void>
): Promise<void> {
  return worktreePreparationGit.run(() =>
    prepareWorktreeCreateInBackground(store, repo, baseBranch, beforeMaterialization)
  )
}

async function prepareWorktreeCreateInBackground(
  store: Store,
  repo: Repo,
  baseBranch: string,
  beforeMaterialization?: Promise<void>
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
  const canonicalBase = await canonicalBaseRef(repo.path, baseBranch, options)
  return startPreparation({
    repoPath: repo.path,
    workspaceRoot,
    baseBranch,
    canonicalBase,
    options,
    beforeMaterialization
  })
}

type ClaimedPreparation =
  | ({ status: 'claimed'; claimedAt: number } & ReservedPreparation)
  | { status: 'miss'; reason: PreparedCheckoutMissReason; rearm?: () => void }

async function claimPreparedWorktree(
  args: ConsumePreparedWorktreeArgs,
  options: AddWorktreeOptions
): Promise<ClaimedPreparation> {
  // Timed on its own so a miss's probes and drift check are not read as the plain add's cost.
  const reserved = await timePhase(args, 'prepared_checkout_claim', () =>
    reservePreparation(args, options)
  )
  if (reserved.status === 'miss') {
    return reserved
  }
  const { entry, reservation } = reserved
  args.timing?.recordAdoptedPreparation(entry.activity.work)
  const claimedAt = performance.now()
  try {
    await timePhase(args, 'prepared_checkout_wait', () => entry.ready)
    return { ...reserved, status: 'claimed', claimedAt }
  } catch {
    return { status: 'miss', reason: 'prepare_failed', rearm: releaseClaimAfterCreate(reservation) }
  }
}

function startDeferredPreparation(preparation: DeferredPreparation): void {
  void startPreparation(preparation.args, preparation.kind).catch(() => {
    // A later create still has the normal add path if speculative preparation fails.
  })
}

function releaseClaimAfterCreate(reservation: PreparationClaim): () => void {
  return () => {
    for (const preparation of releasePreparationClaim(reservation).pendingPreparations) {
      startDeferredPreparation(preparation)
    }
  }
}

/** Replaces a just-consumed preparation, re-armed on the base the create actually used so the
 *  next one hits exactly — but only once the user has shown they are creating in a burst. A
 *  replacement costs a full checkout and ~5 minutes of disk until its TTL, so arming one after an
 *  isolated create spends that on nobody.
 *
 *  Returns a thunk rather than launching: the replacement is a full `reset --hard`, which on a
 *  large repo holds a general admission slot for tens of seconds. Started mid-create it competes
 *  with the create's own git, so the caller runs it after materialization/startup completes. The burst
 *  bookkeeping still happens here so a later create is recognized as part of a burst. An explicit
 *  prefetch during this create takes precedence over the burst replacement at release. */
function deferRearmPreparation(
  entry: PreparationEntry,
  reservation: PreparationClaim,
  baseBranch: string,
  canonicalBase: string
): () => void {
  const continuesBurst = recordPreparationConsume(entry.key)
  return () => {
    const { released, pendingPreparations } = releasePreparationClaim(reservation)
    if (!released) {
      return
    }
    const requestedBaseArmed = pendingPreparations.some(
      (preparation) => preparation.args.canonicalBase === canonicalBase
    )
    for (const preparation of pendingPreparations) {
      startDeferredPreparation(preparation)
    }
    if (continuesBurst && !requestedBaseArmed) {
      startDeferredPreparation({
        args: {
          repoPath: entry.repoPath,
          workspaceRoot: entry.workspaceRoot,
          baseBranch,
          canonicalBase,
          options: entry.options
        },
        kind: 'automatic'
      })
    }
  }
}

export async function consumePreparedWorktreeCreate(
  args: ConsumePreparedWorktreeArgs
): Promise<PreparedWorktreeCreateAttempt> {
  const attempt = await attemptPreparedWorktreeCreate(args)
  args.timing?.recordPreparedCheckout(
    attempt.status === 'hit'
      ? {
          status: 'hit',
          reset: attempt.reset,
          origin: attempt.origin,
          buildMs: attempt.buildMs,
          idleMs: attempt.idleMs
        }
      : { status: 'miss', reason: attempt.reason }
  )
  return attempt
}

function preparedCheckoutReset(retargeted: boolean, headReset: boolean): PreparedCheckoutReset {
  if (!headReset) {
    return 'none'
  }
  return retargeted ? 'retargeted' : 'base_moved'
}

async function attemptPreparedWorktreeCreate(
  args: ConsumePreparedWorktreeArgs
): Promise<PreparedWorktreeCreateAttempt> {
  const options = args.options ?? {}
  const claim = await claimPreparedWorktree(args, options)
  if (claim.status === 'miss') {
    return { status: 'miss', reason: claim.reason, ...(claim.rearm ? { rearm: claim.rearm } : {}) }
  }
  const { entry, reservation } = claim
  try {
    // Finalize resolves the requested base itself and resets the prepared checkout onto that
    // commit, so a retargeted claim is handed over at the requested commit or not at all.
    const { preparedHeadReset, ...result } = await timePhase(
      args,
      'prepared_checkout_finalize',
      async () => {
        const parentDir = isWindowsAbsolutePathLike(args.worktreePath)
          ? win32.dirname(args.worktreePath)
          : posix.dirname(args.worktreePath)
        await mkdir(toHostFilesystemPath(parentDir), { recursive: true })
        return finalizePreparedWorktree(
          args.repoPath,
          entry.preparedPath,
          args.worktreePath,
          args.branch,
          args.baseBranch,
          args.refreshLocalBaseRef,
          options,
          entry.lockReason
        )
      }
    )
    // Consuming the only prepared checkout leaves the next create cold. Re-arm for a user who is
    // creating in a burst; the TTL and the preparation limit still bound an unused replacement.
    const rearm = deferRearmPreparation(entry, reservation, args.baseBranch, claim.canonicalBase)
    return {
      status: 'hit',
      retargeted: claim.retargeted,
      reset: preparedCheckoutReset(claim.retargeted, preparedHeadReset),
      origin: entry.activity.origin(),
      ...entry.activity.timesAt(claim.claimedAt),
      result,
      rearm
    }
  } catch (error) {
    // Another owner holds the preparation's lock, so it is not ours to remove.
    if (!(error instanceof WorktreePreparationLockOwnershipError)) {
      await timePhase(args, 'prepared_checkout_discard', () =>
        discardPreparedWorktree(args.repoPath, entry.preparedPath, options, entry.lockReason)
      ).catch(() => {})
    }
    console.warn(
      '[worktree-create] prepared checkout could not be finalized; using normal add',
      error
    )
    return {
      status: 'miss',
      reason: 'finalize_failed',
      rearm: releaseClaimAfterCreate(reservation)
    }
  }
}

export async function _resetWorktreeCreatePreparationsForTests(): Promise<void> {
  resetPreparationConsumeHistoryForTests()
  await _resetPreparationPoolForTests()
}
