import type {
  AgentSessionBackgroundTaskState,
  AgentSessionHistoryResult,
  AgentSessionSubscribeEvent
} from '../../../../shared/agent-session-wire'
import { AGENT_SESSION_BACKGROUND_TASK_STOP_CAPABILITY } from '../../../../shared/protocol-version'
import type { RpcContext } from '../core'

type BackgroundTaskReader = Pick<RpcContext, 'clientKind' | 'clientCapabilities'>

function supportsReadOnlyTasks(ctx: BackgroundTaskReader): boolean {
  return (
    ctx.clientKind === undefined ||
    ctx.clientCapabilities?.includes(AGENT_SESSION_BACKGROUND_TASK_STOP_CAPABILITY) === true
  )
}

function projectState(
  state: AgentSessionBackgroundTaskState | null | undefined,
  ctx: BackgroundTaskReader
): AgentSessionBackgroundTaskState | null | undefined {
  // Legacy readers always offer a stop; retain their pre-producer empty strip.
  return state?.supportsStopAll === false && !state.supportsTaskStop && !supportsReadOnlyTasks(ctx)
    ? null
    : state
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
