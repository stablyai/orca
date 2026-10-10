// Reading Codex's `collabAgentToolCall` items: the calls an agent makes to spawn, message, wait on
// and close its helpers.
//
// Codex's default multi-agent mode reports a helper ONLY this way; it emits no `subAgentActivity`.
// Shapes are from the app-server's generated schema (0.155) and a live default-mode session:
//   * `spawnAgent` starts with `receiverThreadIds: []`. The helper's thread id first appears when
//     the call ends, beside the `prompt` it was given — even when the call ends `failed`.
//   * Every other call names its helpers from its start. A finished call reports a thread id it
//     does not know as `notFound`; any other state says the helper exists.
//   * Codex core also knows each receiver's nickname and role, but the app-server item does not
//     carry them yet; `readCodexSubagentAnnouncements` is where they would be adopted.
//   * The item names no nickname or task path, so the prompt is the only text that tells one
//     helper from another.
//   * A wait that times out ends naming no receiver and no state.
//   * `agentsStates` is the caller's last-known snapshot of each receiver. The helper's own turn
//     frames own its execution, so nothing here reads it as execution state: only `notFound`,
//     which says the receiver is no helper, and the snapshot a wait or resume reports, which its
//     row shows as output. A spawn's or close's predates what the call did, so its row does not.

import { codexCollabToolRowName } from '../../shared/codex-collab-agent-tools'
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
  /** The receivers that are helpers: every one but those the call reports `notFound`. */
  helperThreadIds: string[]
  prompt: string | null
  /** Each receiver's reported snapshot, in `receiverThreadIds` order: its `CollabAgentStatus`
   *  (`pendingInit`, `running`, `completed`, `errored`, `shutdown`, …) and its message. */
  states: { threadId: string; status: string | null; message: string | null }[]
}

function readReceiverThreadIds(item: CodexThreadItem | undefined): string[] {
  return Array.isArray(item?.receiverThreadIds)
    ? item.receiverThreadIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : []
}

/** `started` is the same call's started item, when it was seen: a call keeps naming the helpers
 *  it started on even when it ends naming fewer, as a timed-out wait ends naming none. */
export function readCodexCollabAgentToolCall(
  item: CodexThreadItem,
  started?: CodexThreadItem
): CodexCollabAgentToolCall | null {
  const tool = readString(item, 'tool')
  if (item.type !== CODEX_COLLAB_AGENT_TOOL_CALL_ITEM_TYPE || tool === null) {
    return null
  }
  const receiverThreadIds = [
    ...new Set([...readReceiverThreadIds(started), ...readReceiverThreadIds(item)])
  ]
  const snapshots = readRecord(item.agentsStates)
  const states = receiverThreadIds.flatMap((threadId) => {
    if (!Object.hasOwn(snapshots, threadId)) {
      return []
    }
    const snapshot = readRecord(snapshots[threadId])
    return [
      { threadId, status: readString(snapshot, 'status'), message: readString(snapshot, 'message') }
    ]
  })
  return {
    id: item.id,
    tool,
    status: readString(item, 'status'),
    receiverThreadIds,
    helperThreadIds: receiverThreadIds.filter(
      (threadId) => readString(readRecord(snapshots[threadId]), 'status') !== 'notFound'
    ),
    prompt: readString(item, 'prompt'),
    states
  }
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

export function codexCollabToolName(call: CodexCollabAgentToolCall): string {
  return codexCollabToolRowName(call.tool)
}
