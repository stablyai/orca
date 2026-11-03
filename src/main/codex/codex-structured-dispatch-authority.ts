import type { CodexTurnHost } from './codex-structured-turn-start'
import { StructuredAgentSessionInputNotAdmitted } from '../native-chat/agent-session-wire/structured-agent-session-input-admission'
import { codexDispatchRejection } from './codex-structured-turn-end-settlement'
import { agentSessionFailureFact } from '../../shared/agent-session/failures/agent-session-failure'

export function checkDispatchAuthority(
  host: CodexTurnHost,
  id: string,
  signal?: AbortSignal,
  isCurrent?: () => boolean
): void {
  if (isCurrent?.() === false) {
    host.dispatchEchoes.disarm(id)
    throw new StructuredAgentSessionInputNotAdmitted({
      state: 'rejected',
      ...codexDispatchRejection(
        agentSessionFailureFact('providerExited', { neverReachedAgent: true })
      )
    })
  }
  if (signal?.aborted) {
    host.dispatchEchoes.disarm(id)
    throw new StructuredAgentSessionInputNotAdmitted({
      state: 'rejected',
      ...codexDispatchRejection(agentSessionFailureFact('cancelled'))
    })
  }
}
