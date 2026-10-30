import {
  renderOrchestrationArgv,
  resolveOrcaCommandsInText,
  type OrchestrationAgentView
} from './agent-view'
import { withReceiptNext } from './receipt-next-text'
import { formatWorkerStart, type WorkerStartReceipt } from './worker-output'

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
}

// A hook-capable agent that has not shown its turn yet is usually slow, not dead; a resend duplicates the task.
function isUnobservedTurnStart(value: WorkerStartAgentReceipt): boolean {
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
        next: unobserved
          ? `Task typed in but the worker hasn't been seen starting; don't resend or abandon it. End your turn; Orca wakes you when it reports. If nothing arrives, run ${renderOrchestrationArgv(['orca', 'orchestration', 'worker-show', '--dispatch', value.dispatchId])}.`
          : value.recovery
            ? resolveOrcaCommandsInText(value.recovery)
            : value.next && resolveOrcaCommandsInText(value.next)
      }
    },
    text: (fields, value) => {
      const lines: string[] = []
      const where = fields.runId
        ? ` in ${fields.runCreated ? 'new ' : ''}Run ${fields.runId}${fields.objective ? `: ${fields.objective}` : ''}`
        : ''
      if (fields.state === 'ready' || isUnobservedTurnStart(value)) {
        const how = [fields.agent, fields.model, fields.effort, fields.mode].filter(Boolean)
        lines.push(
          `${fields.state === 'ready' ? 'Started' : 'Dispatched'} ${fields.dispatchId}${how.length ? ` (${how.join(', ')})` : ''} for ${fields.taskId}${where}`
        )
      } else {
        lines.push(
          `Worker ${fields.dispatchId} ${fields.state}${fields.failedStage ? ` at ${fields.failedStage}` : ''}${fields.lastError ? `: ${fields.lastError}` : ''}`,
          `Task ${fields.taskId}${where}`
        )
      }
      if (fields.terminal || fields.workspace) {
        lines.push(
          `Terminal ${fields.terminal ?? 'none'} in workspace ${fields.workspace ?? 'unknown'}`
        )
      }
      if (fields.modeDetail) {
        lines.push(fields.modeDetail)
      }
      if (fields.warning) {
        lines.push(`Warning: ${fields.warning}`)
      }
      if (fields.residualResources) {
        lines.push(`Left behind: ${fields.residualResources.join(', ')}`)
      }
      lines.push(...(fields.nextCommands ?? []).map((command) => `Next command: ${command}`))
      return withReceiptNext(lines.join('\n'), fields)
    },
    fullText: (value) => withReceiptNext(formatWorkerStart(value), value),
    failure: (value) =>
      value.state === 'ready'
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
            }
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
