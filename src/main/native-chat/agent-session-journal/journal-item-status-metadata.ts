import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { isStructuredAgentSessionCommandEntry } from '../../../shared/agent-session/structured-agent-session-command-entry'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { withoutNativeChatVisualDirectiveLines } from '../../../shared/native-chat/native-chat-visual-directive'

/** Row-local facts status selection seeks by index instead of decoding bodies; never cross-row verdicts. */
export function journalItemStatusMetadata(item: AgentJournalRenderItem) {
  const { body } = item
  return [
    body.kind === 'message' ? body.role : null,
    Number(isStructuredAgentSessionCommandEntry(body)),
    journalItemLifecycleState(body),
    Number(hasAssistantProse(body)),
    item.turnScope?.kind ?? null
  ]
}

export function journalItemLifecycleState(body: AgentJournalItemBody): string | null {
  const turn = readAgentJournalTurn(body)
  if (turn) {
    return turn.state
  }
  if (body.kind === 'approval' || body.kind === 'question') {
    return body.resolution.state
  }
  return body.kind === 'tool-call' ? body.state : null
}

/** Same prose test as the assistant preview, so selection never skips a row the preview would show. */
function hasAssistantProse(body: AgentJournalItemBody): boolean {
  if (body.kind !== 'message' || body.role !== 'assistant') {
    return false
  }
  const prose = body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
  return withoutNativeChatVisualDirectiveLines(prose.join('\n')).trim() !== ''
}
