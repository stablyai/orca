import { historicalTurnLifecycle } from '../../structured/journal/codex-structured-journal-translation-restore'
import { agentJournalTurnBody } from '../../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { interruptedAgentJournalToolCall } from '../../../../shared/agent-journal-tool-call-lifecycle'
import { codexJournalItem } from '../../structured/items/codex-structured-item-translation'
import type { CodexHelperName } from '../../structured/items/codex-collab-agent-item-translation'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { readRecord } from '../../app-server/codex-item-field-readers'
import { codexItemRunState } from '../../structured/items/codex-item-run-state'
import type { CodexThreadItem } from '../../structured/items/codex-thread-item-identity'
import { generatedImageBlocks } from '../../../../shared/native-chat/native-chat-generated-image'

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
    translated = { ...old, blocks: generatedImageBlocks(old.blocks) }
  }
  if (
    old?.kind === 'tool-call' &&
    translated.kind === 'tool-call' &&
    ['commandExecution', 'mcpToolCall', 'collabAgentToolCall'].includes(item.type)
  ) {
    if (item.status == null) {
      translated.state = old.state
    }
    if (old.endedAs === 'interrupted') {
      translated = interruptedAgentJournalToolCall(translated)
    }
    if (translated.output === undefined && old.output !== undefined) {
      translated.output = old.output
    }
  }
  return translated
}

export function projectCodexHistoryItem(
  item: CodexThreadItem,
  saved: AgentJournalRenderItem | null = null,
  interrupted = false,
  helperName?: CodexHelperName
): AgentJournalItemBody | null {
  if (item.type === 'subAgentActivity') {
    return null
  }
  let body =
    item.type === 'contextCompaction'
      ? { kind: 'status' as const, text: 'Context compacted', presentation: 'compaction' as const }
      : codexJournalItem(item, helperName).body
  if (!body) {
    return null
  }
  body = preserveSavedHistoryPayload(item, body, saved)
  if (body.kind === 'tool-call' && (interrupted || body.endedAs === 'interrupted')) {
    body = interruptedAgentJournalToolCall(body)
    if (item.type === 'commandExecution') {
      delete body.exitCode
      delete body.durationMs
    }
  }
  return body
}

export function projectCodexHistoryTurn(
  segment: string,
  source: Record<string, unknown>,
  userItemId?: string
) {
  const lifecycle = historicalTurnLifecycle(segment, source)!
  delete lifecycle.userItemId
  if (userItemId) {
    lifecycle.userItemId = userItemId
  }
  return agentJournalTurnBody(lifecycle)
}
