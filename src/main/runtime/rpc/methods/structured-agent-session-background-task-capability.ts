import type {
  AgentSessionBackgroundTaskState,
  AgentSessionHistoryResult,
  AgentSessionSubscribeEvent
} from '../../../../shared/agent-session-wire'
import {
  AGENT_SESSION_BACKGROUND_TASK_ROW_STOP_CAPABILITY,
  AGENT_SESSION_BACKGROUND_TASK_STOP_CAPABILITY
} from '../../../../shared/protocol-version'
import type { RpcContext } from '../core'

type BackgroundTaskReader = Pick<RpcContext, 'clientKind' | 'clientCapabilities'>

function supportsReadOnlyTasks(ctx: BackgroundTaskReader): boolean {
  return (
    ctx.clientKind === undefined ||
    ctx.clientCapabilities?.includes(AGENT_SESSION_BACKGROUND_TASK_STOP_CAPABILITY) === true
  )
}

function honoursRowStop(ctx: BackgroundTaskReader): boolean {
  return (
    ctx.clientKind === undefined ||
    ctx.clientCapabilities?.includes(AGENT_SESSION_BACKGROUND_TASK_ROW_STOP_CAPABILITY) === true
  )
}

/** A reader that predates `stoppable` draws a per-row stop on every row it is
 *  handed, and the host cannot honour one on a row marked unstoppable — the
 *  dead button the field exists to remove. The host publishing such rows at all
 *  is new, so withholding them hands that reader exactly its pre-feature view;
 *  a state whose every row is withheld becomes no strip, as it was. */
function withoutUnstoppableRows(
  state: AgentSessionBackgroundTaskState
): AgentSessionBackgroundTaskState | null {
  if (!state.tasks?.some((task) => task.stoppable === false)) {
    return state
  }
  const tasks = state.tasks.filter((task) => task.stoppable !== false)
  return tasks.length > 0 ? { ...state, tasks } : null
}

function projectState(
  state: AgentSessionBackgroundTaskState | null | undefined,
  ctx: BackgroundTaskReader
): AgentSessionBackgroundTaskState | null | undefined {
  const rows = !state || honoursRowStop(ctx) ? state : withoutUnstoppableRows(state)
  // Legacy readers always offer a stop; retain their pre-producer empty strip.
  return rows?.supportsStopAll === false && !rows.supportsTaskStop && !supportsReadOnlyTasks(ctx)
    ? null
    : rows
}

export function projectBackgroundTaskHistory(
  result: AgentSessionHistoryResult,
  ctx: BackgroundTaskReader
): AgentSessionHistoryResult {
  const state = projectState(result.page.backgroundTasks, ctx)
  return state === result.page.backgroundTasks
    ? result
    : { ...result, page: { ...result.page, backgroundTasks: state } }
}

export function projectBackgroundTaskEvent(
  event: AgentSessionSubscribeEvent,
  ctx: BackgroundTaskReader
): AgentSessionSubscribeEvent {
  if (!('backgroundTasks' in event)) {
    return event
  }
  const state = projectState(event.backgroundTasks, ctx)
  return state === event.backgroundTasks ? event : { ...event, backgroundTasks: state }
}
