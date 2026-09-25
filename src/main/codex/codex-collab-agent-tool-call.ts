// Reading Codex's `collabAgentToolCall` items: the calls an agent makes to spawn, message, wait on
// and close its helpers.
//
// Codex's default multi-agent mode reports a helper ONLY this way; it emits no `subAgentActivity`.
// Shapes are from the app-server's generated schema (0.155) and a live default-mode session:
//   * `spawnAgent` starts with `receiverThreadIds: []`. The helper's thread id first appears when
//     the call ends, beside the `prompt` it was given — even when the call ends `failed`.
//   * Codex core also knows each receiver's nickname and role, but the app-server item does not
//     carry them yet; `readCodexSubagentAnnouncement` is where they would be adopted.
//   * The item names no nickname or task path, so the prompt is the only text that tells one
//     helper from another.
//   * `agentsStates` is the caller's last-known snapshot of each receiver. The helper's own turn
//     frames own its execution, so nothing here reads it as state; its `message` is what the
//     helper said back, which the call's row shows as output.

import { collapsedToolInputPrefix } from '../../shared/native-chat-tool-preview-prefix'
import { readRecord, readString } from './codex-item-field-readers'
import type { CodexThreadItem } from './codex-thread-item-identity'

export const CODEX_COLLAB_AGENT_TOOL_CALL_ITEM_TYPE = 'collabAgentToolCall'

/** Row length for a helper named by its prompt: long enough to tell two helpers apart. */
const MAX_HELPER_LABEL_CHARS = 80

export type CodexCollabAgentToolCall = {
  id: string
  /** The schema's `CollabAgentTool`: `spawnAgent`, `sendInput`, `wait`, `closeAgent`, … */
  tool: string
  /** `inProgress`, `completed`, `failed` or `interrupted`. */
  status: string | null
  receiverThreadIds: string[]
  prompt: string | null
  /** What each receiver said back, in `receiverThreadIds` order. */
  replies: { threadId: string; message: string }[]
}

export function readCodexCollabAgentToolCall(
  item: CodexThreadItem
): CodexCollabAgentToolCall | null {
  const tool = readString(item, 'tool')
  if (item.type !== CODEX_COLLAB_AGENT_TOOL_CALL_ITEM_TYPE || tool === null) {
    return null
  }
  const receiverThreadIds = Array.isArray(item.receiverThreadIds)
    ? item.receiverThreadIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : []
  const states = readRecord(item.agentsStates)
  const replies = receiverThreadIds.flatMap((threadId) => {
    const message = readString(readRecord(states[threadId]), 'message')
    return message === null ? [] : [{ threadId, message }]
  })
  return {
    id: item.id,
    tool,
    status: readString(item, 'status'),
    receiverThreadIds,
    prompt: readString(item, 'prompt'),
    replies
  }
}

/** The helper a `spawnAgent` created, whatever the call's status: Codex reports `failed` for a
 *  helper that errored at birth, yet names the thread it created, and that thread can still run.
 *  A spawn in progress, or one that created nothing, names no receiver. */
export function codexCollabSpawnedThread(call: CodexCollabAgentToolCall): string | null {
  return call.tool === 'spawnAgent' ? (call.receiverThreadIds[0] ?? null) : null
}

/** The helper a finished `closeAgent` shut down. A failed close left it running. */
export function codexCollabClosedThread(call: CodexCollabAgentToolCall): string | null {
  return call.tool === 'closeAgent' && call.status === 'completed'
    ? (call.receiverThreadIds[0] ?? null)
    : null
}

/** A helper's row label: the head of the prompt it was spawned with, on one line. */
export function codexCollabHelperLabel(prompt: string | null): string | null {
  const collapsed = prompt === null ? '' : collapsedToolInputPrefix(prompt)
  if (collapsed.length <= MAX_HELPER_LABEL_CHARS) {
    return collapsed.length > 0 ? collapsed : null
  }
  const keep = MAX_HELPER_LABEL_CHARS - 1
  // Never end on half a surrogate pair: the label lands in a durable row.
  const last = collapsed.charCodeAt(keep - 1)
  const end = last >= 0xd800 && last <= 0xdbff ? keep - 1 : keep
  return `${collapsed.slice(0, end)}…`
}

/** The name the model called the tool by, which is what its row shows. The wire item spells the
 *  tool in camelCase; the model-facing name is snake_case, so this map is not a spelling fix. */
const CODEX_COLLAB_TOOL_NAMES = new Map<string, string>([
  ['spawnAgent', 'spawn_agent'],
  ['sendInput', 'send_input'],
  ['resumeAgent', 'resume_agent'],
  ['wait', 'wait_agent'],
  ['closeAgent', 'close_agent'],
  ['sendMessage', 'send_message'],
  ['followupTask', 'followup_task'],
  ['interruptAgent', 'interrupt_agent'],
  ['listAgents', 'list_agents']
])

export function codexCollabToolName(call: CodexCollabAgentToolCall): string {
  return CODEX_COLLAB_TOOL_NAMES.get(call.tool) ?? call.tool
}
