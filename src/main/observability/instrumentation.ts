import type { PreparedCheckoutOutcome } from '../../shared/worktree/create-types'
import { withSpan, type ActiveSpan } from './tracer'

export {
  withGitSpan,
  startGitSpan,
  _resetGitSpanSamplingForTests,
  _gitSpanSamplingBucketCountForTests,
  type GitSpanArgs
} from './git-execution-spans'

export type WorktreeSpanArgs = {
  readonly stage: 'clone' | 'checkout' | 'install' | 'create' | 'remove'
  readonly path?: string
}

/** Expose the span to capture phase waits beyond git child processes. */
export async function withWorktreeSpan<T>(
  meta: WorktreeSpanArgs,
  fn: (span: ActiveSpan) => Promise<T>
): Promise<T> {
  return withSpan(
    `worktree.${meta.stage}`,
    async (span) => {
      span.setAttribute('worktree.stage', meta.stage)
      if (meta.path) {
        span.setAttribute('worktree.path', meta.path)
      }
      return await fn(span)
    },
    { attributes: { kind: 'worktree' } }
  )
}

type WorktreeCreatePhaseTiming = {
  readonly phase: string
  readonly startedAtMs: number
  readonly durationMs: number
}

/** Union phase intervals to avoid double-counting concurrent work. */
function measuredWallClockMs(phases: readonly WorktreePhaseInterval[]): number {
  const intervals = [...phases]
    .map((phase) => [phase.startedAtMs, phase.startedAtMs + phase.durationMs] as const)
    .sort((left, right) => left[0] - right[0])
  let covered = 0
  let openedAt: number | null = null
  let closesAt = 0
  for (const [start, end] of intervals) {
    if (openedAt === null) {
      openedAt = start
      closesAt = end
      continue
    }
    if (start <= closesAt) {
      closesAt = Math.max(closesAt, end)
      continue
    }
    covered += closesAt - openedAt
    openedAt = start
    closesAt = end
  }
  return openedAt === null ? 0 : covered + (closesAt - openedAt)
}

type WorktreePhaseInterval = Pick<WorktreeCreatePhaseTiming, 'startedAtMs' | 'durationMs'>

/** Closed phase names exclude user paths and branch names. */
export function addWorktreeCreatePhaseAttributes(
  span: ActiveSpan,
  timing: {
    totalDurationMs: number
    phases: readonly WorktreeCreatePhaseTiming[]
    preparedCheckout?: PreparedCheckoutOutcome
  }
): void {
  span.setAttribute('worktree.create.total_ms', Math.round(timing.totalDurationMs))
  if (timing.preparedCheckout) {
    span.setAttribute('worktree.create.prepared_checkout', timing.preparedCheckout.status)
    if (timing.preparedCheckout.status === 'hit') {
      span.setAttribute('worktree.create.prepared_checkout_reset', timing.preparedCheckout.reset)
      span.setAttribute('worktree.create.prepared_checkout_origin', timing.preparedCheckout.origin)
    } else {
      span.setAttribute('worktree.create.prepared_checkout_miss', timing.preparedCheckout.reason)
    }
  }
  for (const phase of timing.phases) {
    span.setAttribute(`worktree.create.phase.${phase.phase}_ms`, Math.round(phase.durationMs))
  }
  span.setAttribute('worktree.create.unattributed_ms', worktreeCreateUnattributedMs(timing))
}

export function worktreeCreateUnattributedMs(timing: {
  totalDurationMs: number
  phases: readonly WorktreePhaseInterval[]
}): number {
  return Math.max(0, Math.round(timing.totalDurationMs - measuredWallClockMs(timing.phases)))
}

export type WorktreeRemoveStage =
  | 'archive_hook'
  | 'cache_invalidation'
  | 'git_remove'
  | 'metadata_purge'
  | 'pty_sweep'
  | 'watcher_gate'

/** Share kind with children to retain the tree in filtered views; flow distinguishes removal paths. */
export async function withWorktreeRemoveStageSpan<T>(
  stage: WorktreeRemoveStage,
  flow: 'folder' | 'remote' | 'local',
  fn: () => Promise<T>
): Promise<T> {
  return withSpan(`worktree.remove.${stage}`, fn, {
    attributes: { kind: 'worktree', 'worktree.flow': flow }
  })
}

export type UpdaterSpanArgs = {
  readonly stage: 'check' | 'download' | 'install'
}

export async function withUpdaterSpan<T>(
  meta: UpdaterSpanArgs,
  fn: (span: ActiveSpan) => Promise<T> | T
): Promise<T> {
  return withSpan(
    `updater.${meta.stage}`,
    async (span) => {
      span.setAttribute('updater.stage', meta.stage)
      return await fn(span)
    },
    { attributes: { kind: 'updater' } }
  )
}
