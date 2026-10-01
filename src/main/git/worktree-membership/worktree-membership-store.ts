import type { GitWorktreeInfo } from '../../../shared/worktree/types'
import { parseWslPath } from '../../wsl'
import { readTranslatedWorktreeGraph } from '../worktree-list-reader'
import {
  WORKTREE_LIST_TIMEOUT_MS,
  type GitWorktreeExecOptions
} from '../worktree-operation-options'
import { canonicalWorktreePath } from '../worktree-path-comparison'
import {
  buildMembershipModel,
  createMembershipModelShell,
  deriveMembershipModel
} from './worktree-membership-derivation'
import {
  MEMBERSHIP_IDLE_DROP_MS,
  MEMBERSHIP_REUSE_WINDOW_MS,
  type MembershipDerivationStart,
  type WorktreeMembershipModel
} from './worktree-membership-model'
import {
  _resetNotRepositoryVerdictsForTests,
  dropNotRepositoryVerdicts,
  readNotRepositoryVerdict,
  readWithoutModel
} from './worktree-membership-not-repository'
import { PromiseSettlementWaiters } from '../../../shared/promise-settlement-waiters'

export { MissingRepoPathError } from './worktree-membership-derivation'

// One worktree membership model per registered native local repo, owned by the main process. Every
// listing reads it; it re-derives its own truth from disk by stat, so no watcher has to be alive
// for it to be right. Orca's own mutations bump its generation so no read reuses an older result.

export type WorktreeMembershipReadOptions = GitWorktreeExecOptions & {
  /** How long this reader waits on shared model work (default: `timeout`); never shortens Git. */
  waitMs?: number
}

export type WorktreeMembershipRead = {
  rows: GitWorktreeInfo[]
  /** False when no model could be built for the layout and Git answered directly, unannotated. */
  fromModel: boolean
}

/** The model's file reads outlived the caller's deadline, as a hung mount does; Git's own
 *  timeout fails a listing the same way. */
export class WorktreeMembershipTimeoutError extends Error {
  readonly code = 'ETIMEDOUT'
  constructor(repoPath: string) {
    super(`worktree membership read timed out: ${repoPath}`)
  }
}

const models = new Map<string, WorktreeMembershipModel>()

/** Waits on shared model work under this reader's own deadline and signal. */
function awaitModelWork<T>(
  repoPath: string,
  work: PromiseSettlementWaiters<T>,
  options: WorktreeMembershipReadOptions
): Promise<T> {
  // Why the waiter set: on a hung mount the work never settles, and a reader that gave up must not
  // stay attached to it. Zero is no deadline override, as the Git runner treats it.
  return work.wait({
    timeoutMs: options.waitMs || options.timeout || WORKTREE_LIST_TIMEOUT_MS,
    createTimeoutError: () => new WorktreeMembershipTimeoutError(repoPath),
    signal: options.signal,
    createAbortError: () => options.signal?.reason
  })
}

/** The one reuse rule, for finished and in-flight derivations alike. */
function isReusable(
  model: WorktreeMembershipModel,
  start: MembershipDerivationStart,
  now: number
): boolean {
  return start.generation === model.generation && now - start.startedAt < MEMBERSHIP_REUSE_WINDOW_MS
}

function dropModel(model: WorktreeMembershipModel): void {
  if (models.get(model.key) === model) {
    models.delete(model.key)
  }
}

function dropIdleModels(now: number): void {
  for (const [key, model] of models) {
    if (model.building === null && now - model.lastReadAt >= MEMBERSHIP_IDLE_DROP_MS) {
      models.delete(key)
    }
  }
  dropNotRepositoryVerdicts(now)
}

function startModel(
  key: string,
  repoPath: string,
  options: WorktreeMembershipReadOptions
): WorktreeMembershipModel {
  const startedAt = Date.now()
  const model = createMembershipModelShell(key, repoPath, startedAt)
  // Registered before the build starts, so an Orca mark during the build bumps its generation.
  models.set(key, model)
  const work = buildMembershipModel(model, options).then(
    (rows) => {
      if (!Array.isArray(rows)) {
        dropModel(model)
      }
      model.building = null
      return rows
    },
    (error: unknown) => {
      dropModel(model)
      model.building = null
      throw error
    }
  )
  model.building = { generation: 0, startedAt, work: new PromiseSettlementWaiters(work) }
  return model
}

function startDerivation(
  model: WorktreeMembershipModel,
  options: WorktreeMembershipReadOptions
): PromiseSettlementWaiters<GitWorktreeInfo[]> {
  const start = {
    generation: model.generation,
    startedAt: Date.now(),
    listingOwed: model.listingOwed
  }
  model.listingOwed = false
  const derivation = ++model.startedDerivations
  const work: Promise<GitWorktreeInfo[]> = deriveMembershipModel(
    model,
    start,
    options,
    derivation,
    () => dropModel(model)
  )
    .catch((error: unknown) => {
      // A failed derivation proved nothing; the listing re-read it was asked for is still owed.
      model.listingOwed ||= start.listingOwed
      throw error
    })
    .finally(() => {
      if (model.inFlight?.work === shared) {
        model.inFlight = null
      }
    })
  const shared = new PromiseSettlementWaiters(work)
  model.inFlight = { generation: start.generation, startedAt: start.startedAt, work: shared }
  return shared
}

function readModel(
  model: WorktreeMembershipModel,
  options: WorktreeMembershipReadOptions,
  now: number
): Promise<GitWorktreeInfo[]> {
  if (isReusable(model, model.validated, now)) {
    return Promise.resolve(model.rows)
  }
  // A queued follow-up means the running derivation was already too old for an earlier reader.
  if (model.followUp) {
    return awaitModelWork(model.repoPath, model.followUp, options)
  }
  const inFlight = model.inFlight
  if (!inFlight) {
    return awaitModelWork(model.repoPath, startDerivation(model, options), options)
  }
  if (isReusable(model, inFlight, now)) {
    return awaitModelWork(model.repoPath, inFlight.work, options)
  }
  // One derivation per model at a time, so a slow or hung disk never stacks fs work. A reader that
  // cannot reuse the running one shares the next, which starts after it arrived.
  const followUp = inFlight.work.promise
    .then(
      () => undefined,
      () => undefined
    )
    .then(() => {
      model.followUp = null
      return startDerivation(model, options).promise
    })
  model.followUp = new PromiseSettlementWaiters(followUp)
  return awaitModelWork(model.repoPath, model.followUp, options)
}

/**
 * Every worktree Git would list for a native local repo, main first, create preparations included.
 * Rejects when the listing failed or outlived `options.timeout`; a missing repo path rejects with
 * MissingRepoPathError after one stat and no Git. WSL repos are always answered by Git.
 */
export async function readWorktreeMembership(
  repoPath: string,
  options: WorktreeMembershipReadOptions = {}
): Promise<WorktreeMembershipRead> {
  if (options.wslDistro || parseWslPath(repoPath)) {
    return { rows: await readTranslatedWorktreeGraph(repoPath, options), fromModel: false }
  }
  const now = Date.now()
  dropIdleModels(now)
  const key = canonicalWorktreePath(repoPath)
  const verdict = await readNotRepositoryVerdict(key, repoPath, (check) =>
    awaitModelWork(repoPath, check, options)
  )
  if (verdict) {
    throw verdict.error
  }
  const model = models.get(key) ?? startModel(key, repoPath, options)
  model.lastReadAt = now
  const building = model.building
  if (building) {
    // Checked on arrival, as for any in-flight derivation: a later reader re-derives once it lands.
    const reusable = isReusable(model, building, now)
    const rows = await awaitModelWork(model.repoPath, building.work, options)
    if (!Array.isArray(rows)) {
      return { rows: await readWithoutModel(key, repoPath, rows, options), fromModel: false }
    }
    if (reusable) {
      return { rows, fromModel: true }
    }
  }
  return { rows: await readModel(model, options, Date.now()), fromModel: true }
}

/** Orca changed this repo's worktrees (add, remove, move, prune, unlock) or was told they changed. */
export function markWorktreeMembershipDirty(repoPath: string): void {
  const repoKey = canonicalWorktreePath(repoPath)
  const isRepo = (model: WorktreeMembershipModel): boolean =>
    canonicalWorktreePath(model.repoPath) === repoKey
  // Registered repos sharing this repo's common dir share its worktrees. A model still building has
  // no common dir yet, so it is marked too; that costs it one extra stat pass at most.
  const commonDirKeys = new Set(
    [...models.values()].filter(isRepo).map((model) => model.commonDirKey)
  )
  markModels(
    (model) => isRepo(model) || model.building !== null || commonDirKeys.has(model.commonDirKey)
  )
}

export function markAllWorktreeMembershipsDirty(): void {
  markModels(() => true)
}

function markModels(matches: (model: WorktreeMembershipModel) => boolean): void {
  for (const model of models.values()) {
    if (matches(model)) {
      model.generation += 1
      model.listingOwed = true
    }
  }
}

/** Drop models of repos no longer registered; the next read of a re-added repo rebuilds one. */
export function retainWorktreeMembershipModels(registeredRepoPaths: readonly string[]): void {
  const registered = new Set(registeredRepoPaths.map((path) => canonicalWorktreePath(path)))
  for (const [key, model] of models) {
    if (!registered.has(canonicalWorktreePath(model.repoPath))) {
      models.delete(key)
    }
  }
  dropNotRepositoryVerdicts(Date.now(), registered)
}

/**
 * True when the repo's rows come from Git's files, so a read costs stats, not a Git run. A repo the
 * model leaves to Git (WSL, reftable, failed parity, files not readable yet) keeps the upper
 * caches' row TTLs instead.
 */
export function isWorktreeMembershipModelBacked(repoPath: string, wslDistro?: string): boolean {
  const model = wslDistro ? undefined : models.get(canonicalWorktreePath(repoPath))
  return model?.building === null && model.source.kind === 'files' && model.files !== null
}

export function _getWorktreeMembershipModelForTests(
  repoPath: string
): WorktreeMembershipModel | undefined {
  return models.get(canonicalWorktreePath(repoPath))
}

export function _resetWorktreeMembershipModelsForTests(): void {
  models.clear()
  _resetNotRepositoryVerdictsForTests()
}
