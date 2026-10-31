import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../shared/agent-session-journal-types'
import type { CodexThreadItem } from './codex-thread-item-identity'

export function preserveSavedHistoryPayload(
  item: CodexThreadItem,
  translated: AgentJournalItemBody,
  saved: AgentJournalRenderItem | null
): AgentJournalItemBody {
  const old = saved?.body
  if (old?.kind === 'diff' && item.type === 'fileChange' && item.changes === undefined) {
    translated = old
  }
  if (
    old?.kind === 'message' &&
    item.type === 'imageGeneration' &&
    item.status == null &&
    item.savedPath == null &&
    item.result == null &&
    item.failure == null
  ) {
    translated = old
  }
  if (
    old?.kind === 'tool-call' &&
    translated.kind === 'tool-call' &&
    ['commandExecution', 'mcpToolCall', 'collabAgentToolCall'].includes(item.type)
  ) {
    if (item.status == null) {
      translated.state = old.state
    }
    if (translated.output === undefined && old.output !== undefined) {
      translated.output = old.output
    }
  }
  return translated
}
