import { worktreePreparationGit } from './git/worktree-create-git-executor'
import { mkdir } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import type { Store } from './persistence'
import type { Repo } from '../shared/repo-types'
import { isFolderRepo } from '../shared/repo-kind'
import { isWindowsAbsolutePathLike } from '../shared/cross-platform-path'
import type { PreparedCheckoutMissReason } from '../shared/worktree/create-types'
import type { AddWorktreeOptions, AddWorktreeResult } from './git/worktree'
import { measureRetargetDivergence } from './git/worktree-base-divergence'
import { resolveLocalWorktreeBaseRef } from './git/worktree-base-ref-probe'
import { preparationPathKey, selectPreparationForCreate } from './worktree-create-preparation-claim'
import {
  _resetPreparationPoolForTests,
  hasPendingPreparations,
  listPreparations,
  releasePreparationClaim,
  startPreparation,
  takePreparation,
  type DeferredPreparation,
  type PreparationClaim,
  type PreparationEntry
} from './worktree-create-preparation-pool'
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
  timing?: Pick<WorktreeCreateTimingRecorder, 'time'>
}

function canonicalBaseRef(
  repoPath: string,
  baseBranch: string,
  options: AddWorktreeOptions
): Promise<string> {
  return resolveLocalWorktreeBaseRef(repoPath, baseBranch, {
    ...(options.wslDistro ? { wslDistro: options.wslDistro } : {}),
    ...(options.admissionTier ? { admissionTier: options.admissionTier } : {})
  })
}

export function prepareWorktreeCreateForRepo(
  store: Store,
  repo: Repo,
  baseBranch: string
): Promise<void> {
  return worktreePreparationGit.run(() =>
    prepareWorktreeCreateInBackground(store, repo, baseBranch)
  )
}

async function prepareWorktreeCreateInBackground(
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
  const canonicalBase = await canonicalBaseRef(repo.path, baseBranch, options)
  return startPreparation({
    repoPath: repo.path,
    workspaceRoot,
    baseBranch,
    canonicalBase,
    options
  })
}

type ClaimedPreparation =
  | {
      status: 'claimed'
      entry: PreparationEntry
      reservation: PreparationClaim
      retargeted: boolean
      canonicalBase: string
    }
  | { status: 'miss'; reason: PreparedCheckoutMissReason; rearm?: () => void }

async function claimPreparedWorktree(
  args: ConsumePreparedWorktreeArgs,
  options: AddWorktreeOptions
): Promise<ClaimedPreparation> {
  const request = {
    repoPathKey: preparationPathKey(args.repoPath),
    workspaceRootKey: preparationPathKey(args.workspaceRoot),
    wslDistro: options.wslDistro ?? '',
    baseBranch: args.baseBranch
  }
  let selection = selectPreparationForCreate(listPreparations(), {
    ...request,
    canonicalBase: null
  })
  if (selection.kind === 'needs-canonical-base') {
    // The probe is the only await here, and the pool is re-read after it, so the select-and-take
    // below stays one synchronous run and no other create can hold the same entry.
    const canonicalBase = await canonicalBaseRef(args.repoPath, args.baseBranch, options)
    selection = selectPreparationForCreate(listPreparations(), { ...request, canonicalBase })
  }
  if (selection.kind !== 'exact' && selection.kind !== 'retarget') {
    return {
      status: 'miss',
      reason: selection.kind === 'miss' ? selection.reason : 'base_mismatch'
    }
  }
  if (selection.kind === 'retarget') {
    const candidate = selection.candidate
    const { canonicalBase } = selection
    const divergence = await measureRetargetDivergence(
      args.repoPath,
      candidate.canonicalBase,
      canonicalBase,
      {
        ...(options.wslDistro ? { wslDistro: options.wslDistro } : {}),
        ...(options.admissionTier ? { admissionTier: options.admissionTier } : {}),
        // Why forward it: a cancelled create must stop these probes now, not at the deadline.
        ...(options.signal ? { signal: options.signal } : {})
      }
    )
    if (divergence !== 'within') {
      return {
        status: 'miss',
        reason: divergence === 'exceeded' ? 'retarget_too_divergent' : 'retarget_unverifiable'
      }
    }
    // Re-select after the walk: the pool may have gained an exact match or lost this entry. A
    // different retarget candidate is left for the next create rather than claimed unverified.
    selection = selectPreparationForCreate(listPreparations(), { ...request, canonicalBase })
    if (selection.kind === 'miss' || selection.kind === 'needs-canonical-base') {
      return { status: 'miss', reason: 'base_mismatch' }
    }
    if (selection.kind === 'retarget' && selection.candidate !== candidate) {
      return { status: 'miss', reason: 'base_mismatch' }
    }
  }
  const entry = selection.candidate
  const reservation = takePreparation(entry, selection.canonicalBase)
  try {
    await (args.timing
      ? args.timing.time('prepared_checkout_wait', () => entry.ready)
      : entry.ready)
    return {
      status: 'claimed',
      entry,
      reservation,
      retargeted: selection.kind === 'retarget',
      canonicalBase: selection.canonicalBase
    }
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
  const options = args.options ?? {}
  const claim = await claimPreparedWorktree(args, options)
  if (claim.status === 'miss') {
    return { status: 'miss', reason: claim.reason, ...(claim.rearm ? { rearm: claim.rearm } : {}) }
  }
  const { entry, reservation } = claim
  try {
    const parentDir = isWindowsAbsolutePathLike(args.worktreePath)
      ? win32.dirname(args.worktreePath)
      : posix.dirname(args.worktreePath)
    await mkdir(toHostFilesystemPath(parentDir), { recursive: true })
    // Finalize resolves the requested base itself and resets the prepared checkout onto that
    // commit, so a retargeted claim is handed over at the requested commit or not at all.
    const finalize = (): Promise<AddWorktreeResult> =>
      finalizePreparedWorktree(
        args.repoPath,
        entry.preparedPath,
        args.worktreePath,
        args.branch,
        args.baseBranch,
        args.refreshLocalBaseRef,
        options
      )
    const result = args.timing
      ? await args.timing.time('prepared_checkout_finalize', finalize)
      : await finalize()
    // Consuming the only prepared checkout leaves the next create cold. Re-arm for a user who is
    // creating in a burst; the TTL and the preparation limit still bound an unused replacement.
    const rearm = deferRearmPreparation(entry, reservation, args.baseBranch, claim.canonicalBase)
    return { status: 'hit', retargeted: claim.retargeted, result, rearm }
  } catch (error) {
    await discardPreparedWorktree(args.repoPath, entry.preparedPath, options).catch(() => {})
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
