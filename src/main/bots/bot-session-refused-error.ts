import { tuiAgentDisplayName } from '../../shared/agent-launch/catalog/tui-agent-display-names'
import {
  agentSessionStartRefusalParts,
  agentSessionWriteNoticeEnglish
} from '../../shared/agent-session/failures/agent-session-refusal-notice'
import {
  agentSessionRefusalReference,
  type AgentSessionRefusalReference,
  type AgentSessionWireRefusal
} from '../../shared/agent-session/failures/agent-session-wire-refusals'
import { agentSessionRefusalFailure } from '../../shared/agent-session/failures/agent-session-write-failure'

/** A bot chat its agent refused to open: people read the sentence, clients word the refusal in `data`. */
export class BotSessionRefusedError extends Error {
  readonly data: { refusal: AgentSessionRefusalReference }

  constructor(agent: string, refusal: AgentSessionWireRefusal) {
    const agentName = tuiAgentDisplayName(agent)
    super(
      agentSessionWriteNoticeEnglish(
        agentSessionStartRefusalParts(
          agentSessionRefusalFailure(refusal),
          agentName ? { agentName } : {}
        )
      )
    )
    this.name = 'BotSessionRefusedError'
    this.data = { refusal: agentSessionRefusalReference(refusal) }
  }
}
