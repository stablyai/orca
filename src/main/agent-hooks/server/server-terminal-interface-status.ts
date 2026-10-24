import { ClaudeOwedNotificationExpiryTimers } from '../../../shared/claude-owed-notification-expiry-timers'
import { AgentHookServerStatusApplication } from './server-status-application'
import { acceptTerminalInterfaceHook } from './terminal-interface-hook-owner'
import type { TerminalInterfaceOwner } from './terminal-interface-authority'
import type { AgentStatusObservationOrigin } from '../../../shared/agent-status-observation'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type { EnrichedAgentHookEventPayload } from './server-types'

export abstract class AgentHookServerTerminalInterfaceStatus extends AgentHookServerStatusApplication {
  protected readonly claudeOwedNotificationExpiry = new ClaudeOwedNotificationExpiryTimers(
    this.state
  )

  protected acceptTerminalInterfaceReceipt(
    acceptInterfaceHook: ((owner: TerminalInterfaceOwner) => void) | undefined,
    origin: AgentStatusObservationOrigin,
    payload: AgentHookEventPayload,
    incoming: AgentHookEventPayload,
    enriched: EnrichedAgentHookEventPayload
  ): void {
    acceptTerminalInterfaceHook({
      accept: acceptInterfaceHook,
      origin,
      payload,
      incoming,
      enriched,
      enabled: () => this.statusHooksEnabled,
      token: () => this.token,
      generation: () => this.statusHookGeneration,
      row: () => this.state.lastStatusByPaneKey.get(enriched.paneKey),
      sameOwner: (row) => this.sameTerminalOwner(row, enriched),
      retire: () =>
        this.reconcileEndedProcessForPaneKeys([enriched.paneKey], { preserveResumeIdentity: true })
    })
  }
}
