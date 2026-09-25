// A Codex `collabAgentToolCall` item → a tool row that names the helper it acted on.
//
// The row is the call the agent made (`spawn_agent`, `wait_agent`, `close_agent`, …); the helper
// itself is the subagent roster's row. A helper is named the way the roster names it, so the two
// rows read as the same child.

import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import {
  boundInlineText,
  boundToolInput,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import {
  codexCollabHelperLabel,
  codexCollabToolName,
  readCodexCollabAgentToolCall,
  type CodexCollabAgentToolCall
} from './codex-collab-agent-tool-call'
import { readString } from './codex-item-field-readers'
import { codexItemRunState } from './codex-item-run-state'
import type { CodexThreadItem } from './codex-thread-item-identity'

/** The roster's name for a helper thread, or null for one it never registered. */
export type CodexHelperName = (threadId: string) => string | null

/** Who the call acted on. A spawn names its helper by its prompt until the roster holds the
 *  thread it became; a helper the roster never registered (a restored thread) is named by its
 *  thread id. */
function helperNames(call: CodexCollabAgentToolCall, helperName?: CodexHelperName): string {
  if (call.tool === 'spawnAgent') {
    const spawned = call.receiverThreadIds[0]
    return (spawned && helperName?.(spawned)) || codexCollabHelperLabel(call.prompt) || ''
  }
  return call.receiverThreadIds.map((threadId) => helperName?.(threadId) ?? threadId).join(', ')
}

/** What the helpers said back. One reply reads as itself; several are each put under their name. */
function replyText(call: CodexCollabAgentToolCall, helperName?: CodexHelperName): string | null {
  if (call.replies.length === 0) {
    return null
  }
  if (call.replies.length === 1 && call.receiverThreadIds.length === 1) {
    return call.replies[0].message
  }
  return call.replies
    .map(({ threadId, message }) => `${helperName?.(threadId) ?? threadId}: ${message}`)
    .join('\n')
}

export function codexCollabAgentToolCallBody(
  item: CodexThreadItem,
  helperName?: CodexHelperName
): AgentJournalItemBody | null {
  const call = readCodexCollabAgentToolCall(item)
  if (!call) {
    return null
  }
  const description = helperNames(call, helperName)
  const model = readString(item, 'model')
  const reasoningEffort = readString(item, 'reasoningEffort')
  const fields = {
    // `description` is the key the row label reads, so the helper's name leads the row.
    ...(description ? { description } : {}),
    ...(call.prompt ? { prompt: call.prompt } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(call.receiverThreadIds.length > 0 ? { agents: call.receiverThreadIds } : {})
  }
  const reply = replyText(call, helperName)
  const output = reply === null ? null : boundInlineText(reply, DEFAULT_JOURNAL_PAYLOAD_LIMITS)
  return {
    kind: 'tool-call',
    name: codexCollabToolName(call),
    callId: call.id,
    input: boundToolInput(
      Object.keys(fields).length > 0 ? fields : null,
      DEFAULT_JOURNAL_PAYLOAD_LIMITS
    ),
    state: codexItemRunState(item),
    ...(output === null ? {} : { output: output.bounded })
  }
}
