import type { TerminalInterfaceOwner } from './terminal-interface-authority'
import { isSameAgentProcess } from '../../../shared/agent-process-presence'
import { probeAgentProcessPresence } from '../../../shared/agent-process-presence-probe'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type { AgentStatusObservationOrigin } from '../../../shared/agent-status-observation'
import type { EnrichedAgentHookEventPayload } from './server-types'

type HookOwnerHost = {
  accept?: (owner: TerminalInterfaceOwner) => void
  origin: AgentStatusObservationOrigin
  payload: AgentHookEventPayload
  incoming: AgentHookEventPayload
  enriched: EnrichedAgentHookEventPayload
  enabled: () => boolean
  token: () => string
  generation: () => number
  row: () => AgentHookEventPayload | undefined
  sameOwner: (row: AgentHookEventPayload) => boolean
  retire: () => void
}

export function acceptTerminalInterfaceHook(host: HookOwnerHost): void {
  const { accept, origin, payload, incoming, enriched } = host
  if (
    accept &&
    origin === 'hook' &&
    payload.isReplay !== true &&
    !payload.providerSessionOnly &&
    !payload.restoredUnconfirmed &&
    !payload.structuredHost &&
    payload.connectionId === null &&
    !incoming.toolAgentId &&
    (!incoming.agentPresence?.process ||
      !enriched.agentPresence?.process ||
      isSameAgentProcess(incoming.agentPresence.process, enriched.agentPresence.process))
  ) {
    const token = host.token()
    const generation = host.generation()
    const current = (): boolean =>
      host.enabled() &&
      host.token() === token &&
      host.generation() === generation &&
      (() => {
        const row = host.row()
        return (
          row === enriched ||
          Boolean(
            row &&
            !row.providerSessionOnly &&
            !row.restoredUnconfirmed &&
            !row.toolAgentId &&
            host.sameOwner(row) &&
            row.payload.agentType === enriched.payload.agentType &&
            (!row.terminalHandle ||
              !enriched.terminalHandle ||
              row.terminalHandle === enriched.terminalHandle) &&
            row.providerSession?.id === enriched.providerSession?.id &&
            (row.agentPresence === enriched.agentPresence ||
              Boolean(
                row.agentPresence?.process &&
                enriched.agentPresence?.process &&
                isSameAgentProcess(row.agentPresence.process, enriched.agentPresence.process)
              ))
          )
        )
      })()
    accept({
      launchToken: incoming.launchToken,
      token: `${enriched.observation?.authorityId}:${enriched.observation?.revision}`,
      current,
      mayRetire: async () =>
        !enriched.agentPresence?.process ||
        (await probeAgentProcessPresence(enriched.agentPresence.process)) === 'exited',
      retire: () => {
        if (current()) {
          host.retire()
        }
      }
    })
  }
}
