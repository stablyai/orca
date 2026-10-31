import { worktreePreparationGit } from './git/worktree-create-git-executor'
import { mkdir } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import type { ProjectRuntimeResolutionStore } from './local-project-runtime-resolution'
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
import { getRepoRoutingConnectionId } from '../shared/execution-host'

export function hasPendingWorktreeCreatePreparations(): boolean {
  return hasPendingPreparations()
}

/** Fire once in the create's outermost finally, after startup or any post-consume failure. */
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

export type WorktreePreparationStore = Omit<ProjectRuntimeResolutionStore, 'getSettings'> & {
  getSettings(): Pick<
    Parameters<typeof getWorktreePathSettings>[1],
    'workspaceDir' | 'nestWorkspaces'
  > &
    ReturnType<NonNullable<ProjectRuntimeResolutionStore['getSettings']>>
}

export function prepareWorktreeCreateForRepo(
  store: WorktreePreparationStore,
  repo: Repo,
  baseBranch: string,
  beforeMaterialization?: Promise<void>
): Promise<void> {
  return worktreePreparationGit.run(() =>
    prepareWorktreeCreateInBackground(store, repo, baseBranch, beforeMaterialization)
  )
}

async function prepareWorktreeCreateInBackground(
  store: WorktreePreparationStore,
  repo: Repo,
  baseBranch: string,
  beforeMaterialization?: Promise<void>
): Promise<void> {
  if (getRepoRoutingConnectionId(repo) || isFolderRepo(repo)) {
    return
  }
  const options = getLocalProjectWorktreeGitOptions(store, repo)
  // Resolve WSL homes asynchronously to avoid freezing the composer while wsl.exe runs.
  // Match createLocalWorktree's mirror distro so preparation and consume use the same root key.
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
  // Separate claim probes and drift checks from the plain-add duration on misses.
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

/** Defer burst replacement until startup finishes so its disk work does not compete with this create. */
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
    // Finalize resets to the requested commit before handing over a retargeted preparation.
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
