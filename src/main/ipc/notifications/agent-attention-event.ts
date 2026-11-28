import { isAgentNeedsInputAlert } from '../../../shared/notifications/mobile-push-alert'
import type { PluginEventPayload } from '../../../shared/plugins/events/plugin-events'
import type { NotificationDeliveryDependencies } from '../../notifications/notification-delivery-service'
import type { Store } from '../../persistence/loading-store/store'
import type { PluginService } from '../../plugins/plugin-service'

export type AgentAttentionDelivery = Pick<
  NotificationDeliveryDependencies,
  'wantsAgentAttention' | 'emitAgentAttention'
>

export function pluginAgentAttentionDelivery(
  store: Pick<Store, 'listAutomationRuns'>,
  plugins?: Pick<PluginService, 'wantsEvent' | 'emitEvent'>
): AgentAttentionDelivery {
  if (!plugins) {
    return {}
  }
  return {
    wantsAgentAttention: () => plugins.wantsEvent('agent.attention'),
    emitAgentAttention: (request) => {
      const surface = request.surface ?? 'terminal'
      const automation =
        surface === 'terminal' &&
        !request.executionHost &&
        request.paneKey !== undefined &&
        store
          .listAutomationRuns()
          .some(
            (run) =>
              run.status === 'dispatched' &&
              run.workspaceId === request.worktreeId &&
              run.terminalPaneKey === request.paneKey
          )
      plugins.emitEvent('agent.attention', {
        workspaceId: request.worktreeId ?? null,
        paneKey: request.paneKey,
        sessionId: request.structuredOrigin?.sessionId,
        executionHost: request.executionHost,
        surface,
        reason: isAgentNeedsInputAlert(request.source, request.agentState)
          ? 'needs-input'
          : 'turn-ended',
        outcome: request.agentTurnOutcome,
        ...(automation ? { automation: true } : {})
      } satisfies PluginEventPayload<'agent.attention'>)
    }
  }
}
