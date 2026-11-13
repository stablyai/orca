import { nativeChatAgentToolResultText } from '../../../../shared/native-chat/tools/native-chat-agent-tool-result'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { CODEX_COLLAB_ROW_AGENTS_KEY } from '../../../../shared/codex-collab-agent-tools'
import { journalPayload } from '../../../native-chat/agent-session-journal/item-lifecycle/journal-payload-bounds'
import {
  codexCollabHelperLabel,
  codexCollabToolName,
  readCodexCollabAgentToolCall,
  type CodexCollabAgentToolCall
} from './codex-collab-agent-tool-call'
import { readString } from '../../app-server/codex-item-field-readers'
import { codexItemRunState } from './codex-item-run-state'
import type { CodexThreadItem } from './codex-thread-item-identity'

export type CodexHelperName = (threadId: string) => string | null

function helperNames(call: CodexCollabAgentToolCall, helperName?: CodexHelperName): string {
  if (call.tool === 'spawnAgent') {
    const spawned = call.receiverThreadIds[0]
    return (spawned && helperName?.(spawned)) || codexCollabHelperLabel(call.prompt) || ''
  }
  return call.receiverThreadIds.map((threadId) => helperName?.(threadId) ?? threadId).join(', ')
}

function collabRowInput(fields: Record<string, unknown>, prompt: string | null): unknown {
  const input = prompt ? { ...fields, prompt } : fields
  return Object.keys(input).length > 0 ? input : null
}

export function codexCollabAgentToolCallBody(
  item: CodexThreadItem,
  helperName?: CodexHelperName,
  started?: CodexThreadItem
): AgentJournalItemBody | null {
  const call = readCodexCollabAgentToolCall(item, started)
  if (!call) {
    return null
  }
  const description = helperNames(call, helperName)
  const model = readString(item, 'model')
  const reasoningEffort = readString(item, 'reasoningEffort')
  const fields = {
    // Use the roster's helper name as the tool-row label.
    ...(description ? { description } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(call.receiverThreadIds.length > 0
      ? { [CODEX_COLLAB_ROW_AGENTS_KEY]: call.receiverThreadIds }
      : {})
  }
  const text = nativeChatAgentToolResultText(call, helperName)
  return {
    kind: 'tool-call',
    name: codexCollabToolName(call),
    callId: call.id,
    input: collabRowInput(fields, call.prompt),
    state: codexItemRunState(item),
    ...(text === null ? {} : { output: journalPayload(text) })
  }
}
