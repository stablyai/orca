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
  turnStart?: string
  prompt?: { stages?: string[] }
  next?: string
}

// "ready" only means the task was written; say whether the agent was seen picking it up.
const TURN_START_TEXT: Record<string, string> = {
  observed: 'Turn started.',
  permission: 'Turn started; the agent is waiting on a permission prompt.',
  unsupported: 'Task typed in; this agent cannot report that its turn started.',
  unobserved: 'Task typed in; its turn start was not observed yet.'
}

type WorkerStartFields = {
  dispatchId: string
  taskId: string
  runId?: string
  runCreated?: true
  objective?: string
  state: string
  turnStart?: string
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
      // Older runtimes record the observed start only as a prompt stage.
      const turnStart =
        value.turnStart ?? (value.prompt?.stages?.includes('turn_started') ? 'observed' : undefined)
      const unconfirmed = turnStart === 'unsupported' || turnStart === 'unobserved'
      const show = renderOrchestrationArgv([
        'orca',
        'orchestration',
        'worker-show',
        '--dispatch',
        value.dispatchId
      ])
      const runtimeNext = value.next && resolveOrcaCommandsInText(value.next)
      return {
        dispatchId: value.dispatchId,
        taskId: value.taskId,
        runId: value.runId ?? value.run?.id,
        runCreated: value.run?.created ? true : undefined,
        objective: value.run?.created ? value.run.objective : undefined,
        state: value.state,
        turnStart,
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
        lastError: value.lastError,
        warning: value.lastError ? undefined : value.warning,
        residualResources: value.state !== 'ready' && residual.length ? residual : undefined,
        nextCommands: value.state === 'ready' ? undefined : value.nextCommands,
        next: value.recovery
          ? resolveOrcaCommandsInText(value.recovery)
          : unconfirmed
            ? `Do not resend the task; check it with ${show}.${runtimeNext ? ` ${runtimeNext}` : ''}`
            : runtimeNext
      }
    },
    text: (fields) => {
      const lines: string[] = []
      const where = fields.runId
        ? ` in ${fields.runCreated ? 'new ' : ''}Run ${fields.runId}${fields.objective ? `: ${fields.objective}` : ''}`
        : ''
      if (fields.state === 'ready') {
        const how = [fields.agent, fields.model, fields.effort, fields.mode].filter(Boolean)
        lines.push(
          `Started ${fields.dispatchId}${how.length ? ` (${how.join(', ')})` : ''} for ${fields.taskId}${where}`
        )
      } else {
        lines.push(
          `Worker ${fields.dispatchId} ${fields.state}${fields.failedStage ? ` at ${fields.failedStage}` : ''}${fields.lastError ? `: ${fields.lastError}` : ''}`,
          `Task ${fields.taskId}${where}`
        )
      }
      if (fields.turnStart && TURN_START_TEXT[fields.turnStart]) {
        lines.push(TURN_START_TEXT[fields.turnStart])
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
