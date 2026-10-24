// Schema 0.155/live default mode reports helpers through collab calls without subAgentActivity.
// Spawn receivers can first appear at completion, even on failure; prompts supply missing labels.
// agentsStates holds caller snapshots; child turn frames determine execution state.

import { codexCollabToolRowName } from '../../shared/codex-collab-agent-tools'
import { collapsedToolInputPrefix } from '../../shared/native-chat-tool-preview-prefix'
import { readRecord, readString } from './codex-item-field-readers'
import type { CodexThreadItem } from './codex-thread-item-identity'

export const CODEX_COLLAB_AGENT_TOOL_CALL_ITEM_TYPE = 'collabAgentToolCall'

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
  /** Caller snapshots in receiverThreadIds order, excluding receivers with no snapshot. */
  states: { threadId: string; status: string | null; message: string | null }[]
}

function readReceiverThreadIds(item: CodexThreadItem | undefined): string[] {
  return Array.isArray(item?.receiverThreadIds)
    ? item.receiverThreadIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : []
}

/** Retain initial receivers when completion names fewer, e.g. none on a timed-out wait. */
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
