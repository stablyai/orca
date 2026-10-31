import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { projectStructuredItemToNativeChat } from '../../../shared/structured-agent-session-projection'
import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import {
  readAgentJournalTurn,
  readAgentJournalTurnOutcome
} from '../../../shared/agent-session-turn-record'
import { agentTurnVerdict } from '../../../shared/agent-turn-outcome'
import { isInterruptedStatusMessage } from '../../../shared/native-chat-types'
import { isNativeChatContextClear } from '../../../shared/agent-session-context-clear'
import { isClippedToolInput } from './journal-payload-bounds'
import {
  isDeliveredNativeChatUserMessage,
  parseAskFromToolInput
} from '../../../shared/native-chat/input/native-chat-ask'

/** Only changed canonical rows are compared; the complete ordered fold still owns lifecycle. */
export function questionDependency(item: AgentJournalRenderItem): string {
  const scoped = item.turnScope !== undefined
  const turn = readAgentJournalTurn(item.body)
  if (turn && isRootAgentJournalItem(item)) {
    const stopped =
      agentTurnVerdict({ state: turn.state, outcome: readAgentJournalTurnOutcome(turn) }) ===
      'cancellation'
    return JSON.stringify([
      item.itemId,
      item.sequence,
      item.sequenceIndex,
      item.turnScope,
      turn.state === 'running',
      stopped,
      stopped ? (turn.completedAt ?? item.observedAt) : null
    ])
  }
  const message = projectStructuredItemToNativeChat(item)
  if (!message) {
    return String(scoped)
  }
  const calls = message.blocks.filter((block) => block.type === 'tool-call')
  // A bounded input is an unresolved dependency, not evidence that the call is irrelevant.
  const questions = calls.some(
    (call) =>
      isClippedToolInput(call.input) || parseAskFromToolInput(call.name, call.input)?.replyAsMessage
  )
  const lifecycle =
    isDeliveredNativeChatUserMessage(message) ||
    isInterruptedStatusMessage(message) ||
    isNativeChatContextClear(message)
  if (!questions && !lifecycle) {
    return String(scoped)
  }
  const { state: _state, completedAt: _completedAt, ...content } = message
  // Keep every call/slot and lifecycle field, but tool results and execution state aren't questions.
  return JSON.stringify([
    item.sequence,
    item.sequenceIndex,
    item.turnScope,
    {
      ...(lifecycle ? message : content),
      blocks: message.blocks
        .filter(
          (block) => block.type === 'tool-call' || (lifecycle && block.type !== 'tool-result')
        )
        .map((block) =>
          block.type === 'tool-call'
            ? { type: block.type, name: block.name, callId: block.callId, input: block.input }
            : block
        )
    }
  ])
}
