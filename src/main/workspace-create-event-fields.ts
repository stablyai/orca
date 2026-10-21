import type { z } from 'zod'
import type { WorktreeCreateTiming } from '../shared/worktree/create-types'
import {
  WORKTREE_CREATE_PHASES,
  type WorkspaceCreateEntryPoint,
  type WorktreeCreatePhase
} from '../shared/worktree/create-timing-vocabulary'
import type {
  REPO_FILE_COUNT_BUCKETS,
  WORKTREE_COUNT_BUCKETS,
  workspaceCreateFailedProperties,
  workspaceCreatedTimingProperties
} from '../shared/telemetry-workspace-create-schemas'
import type { WorktreeCreateTimingRecorder } from './worktree-create-timing'
import type { WorktreeCreateConcurrency } from './worktree-create-concurrency'
import type { CreateEventRepoFacts } from './git/create-event-repo-probe'
import { worktreeCreateUnattributedMs } from './observability/instrumentation'

type OptionalEventFields<P extends Record<string, z.ZodType>> = { [K in keyof P]?: z.infer<P[K]> }
export type WorkspaceCreateTimingFields = OptionalEventFields<
  typeof workspaceCreatedTimingProperties
>
export type WorkspaceCreateFailureFields = OptionalEventFields<
  typeof workspaceCreateFailedProperties
>
type WorktreeCountBucket = (typeof WORKTREE_COUNT_BUCKETS)[number]
type RepoFileCountBucket = (typeof REPO_FILE_COUNT_BUCKETS)[number]

/** What the create's owner knows beyond the timing the create recorded. */
export type WorkspaceCreateEventContext = {
  entryPoint: WorkspaceCreateEntryPoint
  concurrency: WorktreeCreateConcurrency
}

const KNOWN_PHASES: ReadonlySet<string> = new Set(WORKTREE_CREATE_PHASES)

function isKnownPhase(phase: string): phase is WorktreeCreatePhase {
  return KNOWN_PHASES.has(phase)
}

export function bucketWorktreeCount(count: number): WorktreeCountBucket {
  if (count <= 1) {
    return '1'
  }
  if (count <= 5) {
    return '2-5'
  }
  if (count <= 20) {
    return '6-20'
  }
  if (count <= 100) {
    return '21-100'
  }
  if (count <= 300) {
    return '101-300'
  }
  return count <= 1000 ? '301-1000' : '1001+'
}

export function bucketRepoFileCount(count: number): RepoFileCountBucket {
  if (count < 1_000) {
    return '<1k'
  }
  if (count < 10_000) {
    return '1k-10k'
  }
  if (count < 100_000) {
    return '10k-100k'
  }
  return count < 500_000 ? '100k-500k' : '500k+'
}

function phaseTotals(phases: WorktreeCreateTiming['phases']): Map<WorktreeCreatePhase, number> {
  const totals = new Map<WorktreeCreatePhase, number>()
  for (const phase of phases) {
    // Unknown names are dropped rather than forwarded: only the closed vocabulary may leave.
    if (isKnownPhase(phase.phase)) {
      totals.set(phase.phase, (totals.get(phase.phase) ?? 0) + phase.durationMs)
    }
  }
  return totals
}

function phaseDurationFields(phases: WorktreeCreateTiming['phases']): WorkspaceCreateTimingFields {
  const fields: WorkspaceCreateTimingFields = {}
  for (const [phase, durationMs] of phaseTotals(phases)) {
    fields[`${phase}_ms`] = Math.round(durationMs)
  }
  return fields
}

function preparedCheckoutFields(
  prepared: WorktreeCreateTiming['preparedCheckout']
): WorkspaceCreateFailureFields {
  if (prepared?.status === 'hit') {
    return {
      prepared_checkout: 'hit',
      prepared_checkout_reset: prepared.reset,
      prepared_checkout_origin: prepared.origin,
      prepared_checkout_build_ms: Math.round(prepared.buildMs),
      prepared_checkout_idle_ms: Math.round(prepared.idleMs)
    }
  }
  return prepared
    ? { prepared_checkout: 'miss', prepared_checkout_miss_reason: prepared.reason }
    : {}
}

function contextFields(
  timing: WorktreeCreateTiming,
  context: WorkspaceCreateEventContext
): WorkspaceCreateFailureFields {
  return {
    create_entry_point: context.entryPoint,
    ...(timing.executionHost ? { execution_host: timing.executionHost } : {}),
    concurrent_creates: context.concurrency.otherCreates,
    concurrent_preparations: context.concurrency.preparations
  }
}

function worktreeCountFields(count: number | undefined): WorkspaceCreateTimingFields {
  return count === undefined ? {} : { worktree_count_bucket: bucketWorktreeCount(count) }
}

/** Event fields for a finished create, built only from what the create already measured. */
export function workspaceCreateTimingFields(
  timing: WorktreeCreateTiming,
  context: WorkspaceCreateEventContext & { repoFacts?: CreateEventRepoFacts }
): WorkspaceCreateTimingFields {
  const { repoFacts } = context
  return {
    total_ms: Math.round(timing.totalDurationMs),
    unattributed_ms: worktreeCreateUnattributedMs(timing),
    ...phaseDurationFields(timing.phases),
    ...preparedCheckoutFields(timing.preparedCheckout),
    ...contextFields(timing, context),
    ...worktreeCountFields(repoFacts?.worktreeCount ?? timing.worktreeCount),
    ...(repoFacts?.indexEntryCount !== undefined
      ? { repo_file_count_bucket: bucketRepoFileCount(repoFacts.indexEntryCount) }
      : {}),
    ...(repoFacts ? { post_checkout_hook: repoFacts.postCheckoutHook } : {})
  }
}

/** Event fields for a failed create: where it died, how long it had run, and what the prepared
 *  checkout did before it. */
export function workspaceCreateFailureFields(
  recorder: Pick<WorktreeCreateTimingRecorder, 'failedPhase' | 'finish'>,
  context: WorkspaceCreateEventContext & { error: unknown }
): WorkspaceCreateFailureFields {
  const timing = recorder.finish()
  const waitMs = phaseTotals(timing.phases).get('prepared_checkout_wait')
  return {
    failed_phase: recorder.failedPhase(context.error) ?? 'untimed',
    total_ms: Math.round(timing.totalDurationMs),
    ...preparedCheckoutFields(timing.preparedCheckout),
    ...(waitMs !== undefined ? { prepared_checkout_wait_ms: Math.round(waitMs) } : {}),
    ...contextFields(timing, context)
  }
}
