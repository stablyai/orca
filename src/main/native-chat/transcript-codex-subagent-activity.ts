import type {
  NativeChatMessage,
  NativeChatSubagentState
} from '../../shared/native-chat/native-chat-types'
import { asRecord, extractString } from '../ai-vault/session-scanner-values'

function pathLabel(agentPath: string): string {
  let label = agentPath
  for (const part of agentPath.split('/')) {
    if (part.length > 0) {
      label = part
    }
  }
  return label
}

function activityState(kind: string): NativeChatSubagentState | null {
  switch (kind) {
    case 'started':
    case 'running':
      return 'working'
    case 'completed':
    case 'success':
      return 'completed'
    case 'failed':
    case 'error':
      return 'failed'
    case 'cancelled':
    case 'canceled':
    case 'stopped':
    case 'killed':
      return 'stopped'
    default:
      return null
  }
}

/** Codex writes child start and completion as SubAgentActivity, not as chat text. */
export function codexSubagentActivityMessage(
  payload: Record<string, unknown>,
  timestamp: number | null
): NativeChatMessage | null {
  const item = asRecord(payload.item)
  if (item?.type !== 'SubAgentActivity') {
    return null
  }
  const agentPath = extractString(item.agent_path)
  const id = agentPath ?? extractString(item.agent_thread_id)
  const state = activityState(extractString(item.kind) ?? '')
  if (!id || !state) {
    return null
  }
  return {
    id: extractString(item.id) ?? id,
    role: 'assistant',
    timestamp,
    source: 'transcript',
    blocks: [
      {
        type: 'subagent',
        id,
        label: agentPath ? pathLabel(agentPath) : id,
        state,
        groupId: extractString(payload.turn_id) ?? 'codex'
      }
    ]
  }
}
