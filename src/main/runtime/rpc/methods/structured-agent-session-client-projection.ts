// What each negotiated client is published, composed once for history and the live stream so the
// two can never disagree. Each projection is a no-op for a client that advertises its capability.

import type {
  AgentSessionHistoryResult,
  AgentSessionSubscribeEvent
} from '../../../../shared/agent-session-wire'
import type { RpcContext } from '../core'
import {
  projectBackgroundTaskEvent,
  projectBackgroundTaskHistory
} from './structured-agent-session-background-task-capability'
import {
  projectRecoveredSendEvent,
  projectRecoveredSendHistory
} from './structured-agent-session-recovered-send-capability'
import {
  projectTurnItemEvent,
  projectTurnItemHistory
} from './structured-agent-session-turn-item-capability'

type ClientReader = Pick<RpcContext, 'clientKind' | 'clientCapabilities'>

export function projectStructuredAgentSessionHistoryForClient(
  result: AgentSessionHistoryResult,
  ctx: ClientReader
): AgentSessionHistoryResult {
  return projectRecoveredSendHistory(
    projectTurnItemHistory(projectBackgroundTaskHistory(result, ctx), ctx),
    ctx
  )
}

export function projectStructuredAgentSessionEventForClient(
  event: AgentSessionSubscribeEvent,
  ctx: ClientReader
): AgentSessionSubscribeEvent {
  return projectRecoveredSendEvent(
    projectTurnItemEvent(projectBackgroundTaskEvent(event, ctx), ctx),
    ctx
  )
}
