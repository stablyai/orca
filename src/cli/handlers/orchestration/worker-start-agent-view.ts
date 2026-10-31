import {
  renderOrchestrationArgv,
  resolveOrcaCommandsInText,
  type OrchestrationAgentView,
  type OrchestrationFailure
} from './agent-view'
import { withReceiptNext } from './receipt-next-text'
import {
  formatWorkerStart,
  type WorkerReleaseReceipt,
  type WorkerStartReceipt
} from './worker-output'

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
  /** The retain receipt for --keep-open. */
  keepOpen?: WorkerReleaseReceipt
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
  objective?: string
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
  keepOpenState?: string
  next?: string
}

export const WORKER_START_VIEW: OrchestrationAgentView<WorkerStartAgentReceipt, WorkerStartFields> =
  {
    fields: (value) => {
      const effective = value.launch?.effective
      const requested = value.launch?.requested
      const fellBack = value.mode?.mode !== undefined && value.mode.mode !== value.mode.preferred
      const residual = (value.residualResources ?? []).map(describeEffect)
      const unobserved = isUnobservedTurnStart(value)
      const notKept = notKeptOpen(value)
      return {
        dispatchId: value.dispatchId,
        taskId: value.taskId,
        runId: value.runId ?? value.run?.id,
        runCreated: value.run?.created ? true : undefined,
        objective: value.run?.created ? value.run.objective : undefined,
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
        keptOpen: value.keepOpen?.state === 'retained' ? true : undefined,
        keepOpenState: notKept?.state,
        next: notKept
          ? keepOpenNext(notKept)
          : unobserved
            ? `Task typed in but the worker hasn't been seen starting; don't resend or abandon it. End your turn; Orca wakes you when it reports. If nothing arrives, run ${renderOrchestrationArgv(['orca', 'orchestration', 'worker-show', '--dispatch', value.dispatchId])}.`
            : value.recovery
              ? resolveOrcaCommandsInText(value.recovery)
              : value.next && resolveOrcaCommandsInText(value.next)
      }
    },
    fullText: (value) => withReceiptNext(formatWorkerStart(value), value),
    failure: (value) =>
      keepOpenFailure(value) ??
      (value.state === 'ready'
        ? undefined
        : isUnobservedTurnStart(value)
          ? {
              // The worker is likely starting; a non-zero exit reads as a failure to retry.
              level: 'warning',
              exitCode: 0,
              fullExitCode: 1,
              code: 'turn_start_unobserved',
              message: "task typed in; the worker may still be starting. Don't resend."
            }
          : {
              code: value.state === 'outcome_unknown' ? 'start_outcome_unknown' : 'start_failed',
              message: `${value.failedStage ?? 'start'}: ${value.lastError ?? value.state}`
            })
  }

function notKeptOpen(value: WorkerStartAgentReceipt): WorkerReleaseReceipt | undefined {
  return value.keepOpen && value.keepOpen.state !== 'retained' ? value.keepOpen : undefined
}

// The worker runs either way, so this fails the call without inviting a second start.
function keepOpenFailure(value: WorkerStartAgentReceipt): OrchestrationFailure | undefined {
  const receipt = notKeptOpen(value)
  return receipt
    ? {
        code: 'not_kept_open',
        message: `${value.dispatchId} started but its terminal is ${receipt.state}${receipt.lastError ? `: ${receipt.lastError}` : ''}`
      }
    : undefined
}

function keepOpenNext(receipt: WorkerReleaseReceipt): string {
  if (receipt.recovery) {
    return resolveOrcaCommandsInText(receipt.recovery)
  }
  const verb = receipt.state === 'already_released' ? 'worker-read' : 'worker-show'
  return `Run ${renderOrchestrationArgv(['orchestration', verb, '--dispatch', receipt.dispatchId])}.`
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
