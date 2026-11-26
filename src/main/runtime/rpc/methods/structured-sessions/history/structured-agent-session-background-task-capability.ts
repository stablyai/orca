import type {
  AgentSessionHistoryResult,
  AgentSessionSubscribeEvent
} from '../../../../../../shared/agent-session/agent-session-wire'
import type { AgentSessionBackgroundTaskState } from '../../../../../../shared/agent-session/background-tasks/agent-session-background-task-wire'
import {
  AGENT_SESSION_BACKGROUND_TASK_ROW_STOP_CAPABILITY,
  AGENT_SESSION_BACKGROUND_TASK_STOP_CAPABILITY
} from '../../../../../../shared/agent-session/capabilities/agent-session-runtime-capabilities'
import { AGENT_SESSION_BACKGROUND_TASK_CHILD_VIEWS_CAPABILITY } from '../../../../../../shared/agent-session/background-tasks/agent-session-background-task-child-views-capability'
import type { RpcContext } from '../../../core'

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

function readsChildViews(ctx: BackgroundTaskReader): boolean {
  return (
    ctx.clientKind === undefined ||
    ctx.clientCapabilities?.includes(AGENT_SESSION_BACKGROUND_TASK_CHILD_VIEWS_CAPABILITY) === true
  )
}

/** Older readers interpret every roster as running work; withhold unreadable child views until legacy shapes retire (structured-agent-session-child-work-legacy).
 *  Exact-command availability names child views, so it goes with them. */
function withoutChildViews(
  state: AgentSessionBackgroundTaskState
): AgentSessionBackgroundTaskState {
  const { children: _children, commandDetailsAvailable: _available, ...legacy } = state
  return legacy
}

/** Phones never read exact commands, even when they read child views. */
function withoutCommandDetails(
  state: AgentSessionBackgroundTaskState
): AgentSessionBackgroundTaskState {
  if (state.commandDetailsAvailable === undefined) {
    return state
  }
  const { commandDetailsAvailable: _available, ...rest } = state
  return rest
}

function readsCommandDetails(ctx: BackgroundTaskReader): boolean {
  return ctx.clientKind !== 'mobile' && readsChildViews(ctx)
}

/** The early per-subscriber audience projection: before fitting, fingerprint and comparison, so a
 *  change to availability alone never reaches a phone or legacy reader. */
export function backgroundTaskSubscriberProjection(
  ctx: BackgroundTaskReader
):
  | ((state: AgentSessionBackgroundTaskState | null) => AgentSessionBackgroundTaskState | null)
  | undefined {
  return readsCommandDetails(ctx)
    ? undefined
    : (state) => (state ? withoutCommandDetails(state) : state)
}

/** Older readers draw stop on every row; with targeted-stop support, hide unstoppable rows or they get dead buttons.
 * Without targeted stop there are no buttons to withhold. Empty projected states retain the pre-feature no-strip view. */
function withoutUnstoppableRows(
  state: AgentSessionBackgroundTaskState
): AgentSessionBackgroundTaskState | null {
  if (!state.supportsTaskStop || !state.tasks?.some((task) => task.stoppable === false)) {
    return state
  }
  const tasks = state.tasks.filter((task) => task.stoppable !== false)
  return tasks.length > 0 ? { ...state, tasks } : null
}

function projectState(
  state: AgentSessionBackgroundTaskState | null | undefined,
  ctx: BackgroundTaskReader
): AgentSessionBackgroundTaskState | null | undefined {
  const views = !state
    ? state
    : !readsChildViews(ctx)
      ? withoutChildViews(state)
      : ctx.clientKind === 'mobile'
        ? withoutCommandDetails(state)
        : state
  const rows = !views || honoursRowStop(ctx) ? views : withoutUnstoppableRows(views)
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
