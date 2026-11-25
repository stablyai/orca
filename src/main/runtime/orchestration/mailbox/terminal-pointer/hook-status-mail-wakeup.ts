import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type { AgentStatusIpcPayload } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { EnrichedAgentHookEventPayload } from '../../../../agent-hooks/server/server-types'
import { hookAuthority } from '../../../agent-state-rules/agent-state-rules-engine'
import { subscribeHookStatusTitles } from '../../../terminal/layout/hook-status-title-subscription'
import { hookLeadTurnState } from '../../../../../shared/agent-status/lifecycle/hook-lead-turn-state'

type HookMailWakeupRuntime = {
  resolvePtyIdForHookPane(paneKey: string): string | null
  getPaneAgentForHookMail(ptyId: string): TuiAgent | null
  wakeHeldMailForHookTurnDone(ptyId: string): void
}

/** Wakes held orchestration mail when a live turn-end hook lands (including monitoring with mainAgent done). */
export function dispatchHookStatusMailWakeup(
  enriched: EnrichedAgentHookEventPayload,
  runtime: HookMailWakeupRuntime
): void {
  if (
    enriched.structuredHost ||
    enriched.providerSessionOnly ||
    enriched.isReplay ||
    enriched.restoredUnconfirmed ||
    enriched.observation?.origin !== 'hook'
  ) {
    return
  }
  if (hookLeadTurnState(enriched.payload) !== 'done') {
    return
  }
  const ptyId = runtime.resolvePtyIdForHookPane(enriched.paneKey)
  if (!ptyId) {
    return
  }
  const agent = runtime.getPaneAgentForHookMail(ptyId)
  if (
    !agent ||
    hookAuthority(agent) === 'identity-only' ||
    (enriched.payload.agentType && enriched.payload.agentType !== agent)
  ) {
    return
  }
  runtime.wakeHeldMailForHookTurnDone(ptyId)
}

export function subscribeHookStatusRuntime(
  subscribeEnrichedStatus: (listener: (row: EnrichedAgentHookEventPayload) => void) => () => void,
  titlesRuntime: { recordHookStatusTitle(row: AgentStatusIpcPayload): void },
  onMailStatus: (row: EnrichedAgentHookEventPayload) => void
): () => void {
  const detachTitles = subscribeHookStatusTitles({ subscribeEnrichedStatus }, titlesRuntime)
  const detachMail = subscribeEnrichedStatus(onMailStatus)
  return () => {
    detachMail()
    detachTitles()
  }
}
