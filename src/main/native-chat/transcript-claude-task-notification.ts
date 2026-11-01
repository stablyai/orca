import { nativeChatRosterActivityLine } from '../../shared/native-chat/input/native-chat-roster-activity-line'
import type {
  NativeChatMessage,
  NativeChatSubagentState
} from '../../shared/native-chat/native-chat-types'
import { timestampMs } from '../ai-vault/session-scanner-values'

const NOTICE = /<task-notification>[\s\S]*?<\/task-notification>/
const TASK_ID = /<task-id>\s*([^<]+?)\s*<\/task-id>/
const STATUS = /<status>\s*([^<]+?)\s*<\/status>/
const SUMMARY = /<summary>\s*Agent "([^"]+)"/
const RESULT = /<result>([\s\S]*?)<\/result>/

function noticeState(status: string): NativeChatSubagentState | null {
  switch (status.toLowerCase()) {
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
    case 'running':
    case 'pending':
    case 'in_progress':
      return 'working'
    default:
      return null
  }
}

/** Claude queues a task-notification when a background Agent finishes. The chat decoder otherwise skips it. */
export function claudeTaskNotificationMessage(
  record: Record<string, unknown>,
  fallbackId: string
): NativeChatMessage | null {
  if (record.type !== 'queue-operation' || typeof record.content !== 'string') {
    return null
  }
  const notice = NOTICE.exec(record.content)?.[0]
  const id = notice ? TASK_ID.exec(notice)?.[1]?.trim() : undefined
  const state = notice ? noticeState(STATUS.exec(notice)?.[1]?.trim() ?? '') : null
  if (!notice || !id || !state) {
    return null
  }
  const quoted = SUMMARY.exec(notice)?.[1]?.trim()
  const label = quoted || id
  const activity = nativeChatRosterActivityLine(RESULT.exec(notice)?.[1] ?? '')
  const timestamp = timestampMs(record.timestamp)
  return {
    id: fallbackId,
    role: 'assistant',
    timestamp: Number.isFinite(timestamp) ? timestamp : null,
    source: 'transcript',
    blocks: [
      {
        type: 'subagent',
        id,
        label,
        state,
        groupId: 'claude',
        ...(activity && activity !== label ? { activity } : {})
      }
    ]
  }
}
