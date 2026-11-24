import type {
  BranchAutoRenameAttemptEvent,
  BranchAutoRenameOutcome
} from '../../../shared/worktree/branch-auto-rename-attempt'
import {
  clearFirstWorkGenerationFailures,
  recordFirstWorkGenerationFailure,
  resetFirstWorkGenerationBackoff
} from './first-work-generation-backoff'
import {
  armFirstWorkDetachedHeadCooldown,
  clearFirstWorkDetachedHeadCooldown,
  resetFirstWorkDetachedHeadCooldowns
} from './first-work-detached-head-cooldown'

export type FirstWorkRenameVerdict = {
  outcome: BranchAutoRenameOutcome
  /** Settled verdicts stop automatic attempts for this workspace incarnation. */
  settles: boolean
  /** Counts toward the automatic backoff. */
  generationFailed?: true
  /** Git confirmed a detached HEAD; pauses automatic attempts. */
  detachedHead?: true
}

export type FirstWorkAttemptResult = {
  attemptId: number
  outcome: BranchAutoRenameOutcome
  finishedAt: number
}

export type FirstWorkAttempt = {
  readonly attemptId: number
  /** False once the workspace was replaced, the lookup expired or a newer attempt superseded this one. */
  isCurrent: () => boolean
  expireLookup: () => void
  /** Throws when the workspace was deleted and recreated since admission. */
  assertIncarnation: () => void
  isIncarnationCurrent: () => boolean
}

export type FirstWorkAttemptDeps = {
  /** Identifies one workspace incarnation; null when the workspace is gone. */
  readIncarnation: (worktreeId: string) => string | null
}

let notifyAttempt: (event: BranchAutoRenameAttemptEvent) => void = () => {}

/** The desktop UI installs this; headless serve has no listener. */
export function installFirstWorkAttemptNotifier(
  notifier: (event: BranchAutoRenameAttemptEvent) => void
): void {
  notifyAttempt = notifier
}

type AttemptEntry = {
  incarnation: string
  attemptId: number
  lookupExpired: boolean
  /** False once a manual Retry joined: the click must not leave a pause behind. */
  armsCooldown: boolean
  promise: Promise<FirstWorkAttemptResult>
}

export class FirstWorkWorkspaceReplacedError extends Error {
  constructor() {
    super('workspace was replaced during the rename attempt')
  }
}

// Cache only definitive verdicts, keyed by incarnation so a recreated workspace is not suppressed.
const inFlight = new Map<string, AttemptEntry>()
const settled = new Map<string, string>()
let lastAttemptId = 0
export const FIRST_WORK_BRANCH_RENAME_SETTLED_CACHE_LIMIT = 500

export function resetFirstWorkBranchRenameState(): void {
  inFlight.clear()
  settled.clear()
  resetFirstWorkGenerationBackoff()
  resetFirstWorkDetachedHeadCooldowns()
}

export function isFirstWorkRenameSettled(worktreeId: string, incarnation: string): boolean {
  const settledIncarnation = settled.get(worktreeId)
  if (settledIncarnation !== undefined && settledIncarnation !== incarnation) {
    settled.delete(worktreeId)
    return false
  }
  return settledIncarnation === incarnation
}

/** The running attempt a click may join: same incarnation and still able to generate. */
export function runningFirstWorkAttempt(
  worktreeId: string,
  incarnation: string
): { attemptId: number; promise: Promise<FirstWorkAttemptResult> } | null {
  const entry = inFlight.get(worktreeId)
  return entry && entry.incarnation === incarnation && !entry.lookupExpired ? entry : null
}

/** Manual Retry: clears the detached-HEAD pause before joining, so a joined attempt cannot re-arm it. */
export function joinFirstWorkAttemptForRetry(
  worktreeId: string,
  incarnation: string
): { attemptId: number; promise: Promise<FirstWorkAttemptResult> } | null {
  clearFirstWorkDetachedHeadCooldown(worktreeId)
  const entry = inFlight.get(worktreeId)
  if (!entry || entry.incarnation !== incarnation || entry.lookupExpired) {
    return null
  }
  entry.armsCooldown = false
  return entry
}

function rememberSettled(worktreeId: string, incarnation: string): void {
  // Bound long-lived deduplication at the cost of occasional re-probes.
  settled.delete(worktreeId)
  settled.set(worktreeId, incarnation)
  while (settled.size > FIRST_WORK_BRANCH_RENAME_SETTLED_CACHE_LIMIT) {
    const oldest = settled.keys().next().value
    if (typeof oldest !== 'string') {
      return
    }
    settled.delete(oldest)
  }
}

/** Admits one attempt; a stale entry for another incarnation is superseded, never joined. */
export function startFirstWorkAttempt(
  worktreeId: string,
  incarnation: string,
  run: (attempt: FirstWorkAttempt) => Promise<FirstWorkRenameVerdict>,
  deps: FirstWorkAttemptDeps
): { attemptId: number; promise: Promise<FirstWorkAttemptResult> } {
  const attemptId = ++lastAttemptId
  const incarnationCurrent = () => deps.readIncarnation(worktreeId) === incarnation
  const entry: AttemptEntry = {
    incarnation,
    attemptId,
    lookupExpired: false,
    armsCooldown: true,
    promise: Promise.resolve({ attemptId, outcome: { kind: 'failed' }, finishedAt: 0 })
  }
  const attempt: FirstWorkAttempt = {
    attemptId,
    isCurrent: () =>
      inFlight.get(worktreeId) === entry && !entry.lookupExpired && incarnationCurrent(),
    expireLookup: () => {
      entry.lookupExpired = true
    },
    isIncarnationCurrent: incarnationCurrent,
    assertIncarnation: () => {
      if (!incarnationCurrent()) {
        throw new FirstWorkWorkspaceReplacedError()
      }
    }
  }
  inFlight.set(worktreeId, entry)
  notifyAttempt({ executionHostId: 'local', worktreeId, attemptId, phase: 'started' })
  entry.promise = settleAttempt(worktreeId, entry, () => run(attempt), incarnationCurrent)
  return entry
}

async function settleAttempt(
  worktreeId: string,
  entry: AttemptEntry,
  run: () => Promise<FirstWorkRenameVerdict>,
  incarnationCurrent: () => boolean
): Promise<FirstWorkAttemptResult> {
  let verdict: FirstWorkRenameVerdict
  try {
    verdict = await run()
  } catch (error) {
    if (!(error instanceof FirstWorkWorkspaceReplacedError)) {
      console.warn('[auto-branch-rename] rename attempt failed:', error)
    }
    verdict = {
      outcome:
        error instanceof FirstWorkWorkspaceReplacedError
          ? { kind: 'ineligible', reason: 'unavailable' }
          : { kind: 'deferred', reason: 'interrupted' },
      settles: false
    }
  }
  // One synchronous check: a replaced or superseded attempt must not gate, pause or back off its successor.
  const isEntry = inFlight.get(worktreeId) === entry
  if (isEntry && incarnationCurrent()) {
    if (verdict.settles) {
      clearFirstWorkGenerationFailures(worktreeId)
      rememberSettled(worktreeId, entry.incarnation)
    } else if (verdict.generationFailed) {
      recordFirstWorkGenerationFailure(worktreeId, entry.incarnation)
    }
    if (verdict.detachedHead && entry.armsCooldown) {
      armFirstWorkDetachedHeadCooldown(worktreeId, entry.incarnation)
    } else {
      clearFirstWorkDetachedHeadCooldown(worktreeId)
    }
  }
  if (isEntry) {
    inFlight.delete(worktreeId)
  }
  const result = { attemptId: entry.attemptId, outcome: verdict.outcome, finishedAt: Date.now() }
  notifyAttempt({ executionHostId: 'local', worktreeId, phase: 'finished', ...result })
  return result
}
