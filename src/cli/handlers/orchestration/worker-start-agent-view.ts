import { renderOrchestrationArgv, type OrchestrationAgentView } from './agent-view'
import type { WorkerStartReceipt } from './worker-output'

type LaunchChoice = {
  agent?: string | null
  model?: string | null
  effort?: string | null
}

export type WorkerStartAgentReceipt = WorkerStartReceipt & {
  runId?: string
  mode?: { mode?: string; preferred?: string; detail: string }
  launch?: { requested?: LaunchChoice; effective?: LaunchChoice }
  recovery?: string
  stage?: string
  turnStart?: string
  next?: string
  keptOpen?: true
  pending?: unknown
}

/** The host's accepted launch, still running Setup or the agent start, that delivers the task once. */
export type PendingWorkerStart = {
  operationId: string
  fingerprint: string
  daemonGeneration: string
  reservationGeneration: string
}

/** Only a receipt naming the whole accepted identity is pending; anything less stays unknown. */
export function acceptedPendingStart(
  value: WorkerStartAgentReceipt
): PendingWorkerStart | undefined {
  const pending = value.pending
  if (value.state !== 'outcome_unknown' || typeof pending !== 'object' || pending === null) {
    return undefined
  }
  const read = (key: keyof PendingWorkerStart): string | undefined => {
    const field: unknown = Reflect.get(pending, key)
    return typeof field === 'string' && field.length > 0 ? field : undefined
  }
  const operationId = read('operationId')
  const fingerprint = read('fingerprint')
  const daemonGeneration = read('daemonGeneration')
  const reservationGeneration = read('reservationGeneration')
  return operationId && fingerprint && daemonGeneration && reservationGeneration
    ? { operationId, fingerprint, daemonGeneration, reservationGeneration }
    : undefined
}

// A hook-capable agent that has not shown its turn yet is usually slow, not dead; a resend duplicates the task.
export function isUnobservedTurnStart(value: WorkerStartAgentReceipt): boolean {
  return (
    value.state === 'outcome_unknown' &&
    (value.turnStart === 'unobserved' || value.stage === 'turn_start_unobserved')
  )
}

type WorkerStartFields = {
  dispatchId: string
  taskId: string
  runId?: string
  runCreated?: true
  state: string
  agent?: string
  model?: string
  effort?: string
  mode?: string
  modeDetail?: string
  terminal?: string
  workspace?: string
  failedStage?: string
  lastError?: string
  warning?: string
  residualResources?: string[]
  nextCommands?: string[]
  keptOpen?: true
  pending?: PendingWorkerStart
  next?: string
}

export const WORKER_START_VIEW: OrchestrationAgentView<WorkerStartAgentReceipt, WorkerStartFields> =
  {
    fields: (value) => {
      const effective = value.launch?.effective
      const requested = value.launch?.requested
      const fellBack = value.mode?.mode !== undefined && value.mode.mode !== value.mode.preferred
      const residual = (value.residualResources ?? []).map(describeEffect)
      const pending = acceptedPendingStart(value)
      // Both are a live start the caller must not repeat; only the worker's own report ends them.
      const unobserved = isUnobservedTurnStart(value) || pending !== undefined
      return {
        dispatchId: value.dispatchId,
        taskId: value.taskId,
        runId: value.runId ?? value.run?.id,
        runCreated: value.run?.created ? true : undefined,
        state: value.state,
        agent: effective?.agent ?? requested?.agent ?? undefined,
        // Null unless requested or chosen by a fallback.
        model: effective?.model ?? requested?.model ?? undefined,
        effort: effective?.effort ?? requested?.effort ?? undefined,
        mode: value.mode?.mode,
        modeDetail: fellBack ? value.mode?.detail : undefined,
        // Derived from effects so older runtimes show the handle a reuse needs.
        terminal: findEffectId(value.effects, 'terminal', 'agent'),
        workspace: findEffectId(value.effects, 'worktree'),
        failedStage: value.failedStage,
        lastError: unobserved ? undefined : value.lastError,
        warning: value.lastError ? undefined : value.warning,
        // Its terminal is the live worker, and abandon or a screen read would invite a retry.
        residualResources:
          value.state !== 'ready' && !unobserved && residual.length ? residual : undefined,
        nextCommands: value.state === 'ready' || unobserved ? undefined : value.nextCommands,
        keptOpen: value.keptOpen,
        pending,
        next: pending
          ? `Setup or the agent launch is still running; Orca delivers the task once it is ready. Don't resend or abandon it. End your turn; Orca wakes you when it reports. To check on it, run ${renderOrchestrationArgv(['orca', 'orchestration', 'worker-show', '--dispatch', value.dispatchId])}.`
          : isUnobservedTurnStart(value)
            ? `Task typed in but the worker hasn't been seen starting; don't resend or abandon it. End your turn; Orca wakes you when it reports. If nothing arrives, run ${renderOrchestrationArgv(['orca', 'orchestration', 'worker-show', '--dispatch', value.dispatchId])}.`
            : value.recovery
              ? value.recovery
              : value.next
      }
    },
    failure: (value) =>
      value.state === 'ready'
        ? undefined
        : acceptedPendingStart(value)
          ? {
              // Accepted work continues; a non-zero exit reads as a failure to retry.
              level: 'warning',
              exitCode: 0,
              code: 'start_pending',
              message: "Setup or launch still pending; the task will be delivered. Don't resend."
            }
          : isUnobservedTurnStart(value)
            ? {
                // The worker is likely starting; a non-zero exit reads as a failure to retry.
                level: 'warning',
                exitCode: 0,
                code: 'turn_start_unobserved',
                message: "task typed in; the worker may still be starting. Don't resend."
              }
            : {
                code: value.state === 'outcome_unknown' ? 'start_outcome_unknown' : 'start_failed',
                message: `${value.failedStage ?? 'start'}: ${value.lastError ?? value.state}`
              }
  }

/** A send a finished worker took as its next Task: worker-start's receipt plus where it went. */
export type WorkerFollowUpReceipt = WorkerStartAgentReceipt & {
  delivery: 'follow_up' | 'reopened' | 'started_fresh'
  followUpOf: string
}

type WorkerFollowUpFields = Omit<WorkerStartFields, 'mode' | 'modeDetail'> & {
  delivery: WorkerFollowUpReceipt['delivery']
  followUpOf: string
  /** Behind the worker's own finishing turn: it runs when that turn ends. */
  queued?: true
  mode?: string
  modeDetail?: string
}

export const WORKER_FOLLOW_UP_VIEW: OrchestrationAgentView<
  WorkerFollowUpReceipt,
  WorkerFollowUpFields
> = {
  fields: (value) => {
    const { mode, modeDetail, ...start } = WORKER_START_VIEW.fields(value)
    return {
      delivery: value.delivery,
      followUpOf: value.followUpOf,
      ...start,
      queued: value.turnStart === 'queued' ? true : undefined,
      // The launch mode describes a new worker; only a fresh start is one.
      ...(value.delivery === 'started_fresh' ? { mode, modeDetail } : {})
    }
  },
  failure: WORKER_START_VIEW.failure
}

function findEffectId(
  effects: unknown[] | undefined,
  kind: string,
  role?: string
): string | undefined {
  for (const effect of effects ?? []) {
    if (
      typeof effect === 'object' &&
      effect !== null &&
      'kind' in effect &&
      effect.kind === kind &&
      (role === undefined || ('role' in effect && effect.role === role)) &&
      'id' in effect &&
      typeof effect.id === 'string'
    ) {
      return effect.id
    }
  }
  return undefined
}

function describeEffect(effect: unknown): string {
  if (typeof effect !== 'object' || effect === null) {
    return String(effect)
  }
  const kind = 'kind' in effect && typeof effect.kind === 'string' ? effect.kind : 'resource'
  const id = 'id' in effect && typeof effect.id === 'string' ? effect.id : undefined
  return id ? `${kind} ${id}` : kind
}
