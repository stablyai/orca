import type { WebSocket } from 'ws'
import type { RpcRequest, RpcRespond, RpcResponse } from './mock-server-rpc-handlers'
import { activityScenarioAgents, MOCK_ACTIVITY_VIEW } from './mock-server-activity-scenario'
import {
  agentActivityReadState,
  changeAgentActivityReadState
} from '../../src/shared/agent-activity-read-state'
import type { PersistedUIState } from '../../src/shared/persisted-ui-state-types'
import { SetAgentActivityReadStateParams } from '../../src/shared/rpc-contract/agent-activity-read-params'

let ui: Pick<PersistedUIState, 'acknowledgedAgentsByPaneKey' | 'manuallyUnreadTurnsByPaneKey'> = {
  acknowledgedAgentsByPaneKey: {},
  manuallyUnreadTurnsByPaneKey: {}
}
const subscribers = new Map<string, { requestId: string; respond: RpcRespond }>()

export function handleMockActivityRead(
  request: RpcRequest,
  respond: RpcRespond,
  success: (id: string, result: unknown, streaming?: boolean) => RpcResponse,
  error: (id: string, code: string, message: string) => RpcResponse,
  ws: WebSocket,
  worktreeId: string
): boolean {
  if (!MOCK_ACTIVITY_VIEW) {
    return false
  }
  const subjects = activityScenarioAgents().map((agent) => ({
    paneKey: agent.paneKey,
    worktreeId,
    hostId: 'local',
    latestActivityAt: agent.stateStartedAt,
    stateStartedAt: agent.stateStartedAt
  }))
  switch (request.method) {
    case 'ui.getAgentActivityReadState':
      respond(
        success(request.id, {
          available: true,
          activities: subjects.map((subject) => agentActivityReadState(subject, ui))
        })
      )
      return true
    case 'ui.setAgentActivityReadState': {
      const params = SetAgentActivityReadStateParams.safeParse(request.params)
      const subject =
        params.success &&
        subjects.find(
          (subject) =>
            subject.paneKey === params.data.paneKey &&
            subject.hostId === params.data.hostId &&
            subject.worktreeId === params.data.worktreeId
        )
      if (!params.success || !subject) {
        respond(error(request.id, 'invalid_params', 'Unknown activity'))
        return true
      }
      ui = changeAgentActivityReadState(ui, subject, params.data.read, params.data.latestActivityAt)
      respond(success(request.id, agentActivityReadState(subject, ui)))
      for (const subscriber of subscribers.values()) {
        subscriber.respond(
          success(subscriber.requestId, { type: 'agentActivityReadStateChanged' }, true)
        )
      }
      return true
    }
    case 'runtime.clientEvents.subscribe': {
      const id = `activity-${request.id}`
      subscribers.set(id, { requestId: request.id, respond })
      ws.once('close', () => {
        subscribers.delete(id)
      })
      respond(success(request.id, { type: 'ready', subscriptionId: id }, true))
      return true
    }
    case 'runtime.clientEvents.unsubscribe':
      subscribers.delete(String(request.params?.subscriptionId))
      respond(success(request.id, { unsubscribed: true }))
      return true
    default:
      return false
  }
}
