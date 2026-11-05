import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { readRecord } from '../../app-server/codex-item-field-readers'
import { codexItemRunState } from '../../structured/items/codex-item-run-state'
import type { CodexThreadItem } from '../../structured/items/codex-thread-item-identity'

export function preserveSavedHistoryPayload(
  item: CodexThreadItem,
  translated: AgentJournalItemBody,
  saved: AgentJournalRenderItem | null
): AgentJournalItemBody {
  const old = saved?.body
  if (item.type === 'fileChange' && item.changes === undefined) {
    const fields = readRecord(old?.kind === 'tool-call' ? old.input : null)
    const patch =
      old?.kind === 'diff'
        ? old
        : old?.kind === 'tool-call' &&
            old.name === 'Diff' &&
            typeof fields.path === 'string' &&
            Object.keys(fields).length === 1 &&
            old.output
          ? { path: fields.path, patch: old.output }
          : null
    if (patch && old) {
      // Retained bytes never override authoritative application status.
      const state = codexItemRunState(item)
      translated =
        item.status == null
          ? old
          : state === 'completed'
            ? { kind: 'diff', path: patch.path, patch: patch.patch }
            : {
                kind: 'tool-call',
                name: 'Diff',
                callId: old?.kind === 'tool-call' ? old.callId : item.id,
                input: { path: patch.path },
                output: patch.patch,
                state
              }
    }
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
