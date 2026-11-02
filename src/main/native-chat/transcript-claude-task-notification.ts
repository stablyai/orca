import { isAgentChildWorkKind } from '../../shared/agent-status-child-work-liveness'
import { classifyClaudeBackgroundTaskKind } from '../../shared/claude-background-task-kind'
import { nativeChatRosterActivityLine } from '../../shared/native-chat/input/native-chat-roster-activity-line'
import type {
  NativeChatMessage,
  NativeChatSubagentState
} from '../../shared/native-chat/native-chat-types'
import { timestampMs } from '../ai-vault/session-scanner-values'

const NOTICE = /<task-notification>[\s\S]*?<\/task-notification>/
const TASK_ID = /<task-id>\s*([^<]+?)\s*<\/task-id>/
const TASK_TYPE = /<task[-_]type>\s*([^<]+?)\s*<\/task[-_]type>/
const STATUS = /<status>\s*([^<]+?)\s*<\/status>/
const SUMMARY = /<summary>\s*Agent "([^"]+)"/
const RESULT = /<result>([\s\S]*?)<\/result>/

/** A shell or monitor reuses this tag. Only an agent child belongs on the subagent roster. */
function agentLabel(notice: string): string | null {
  const taskType = TASK_TYPE.exec(notice)?.[1]?.trim()
  const kind = taskType ? classifyClaudeBackgroundTaskKind(taskType) : 'unknown'
  if (kind !== 'unknown' && !isAgentChildWorkKind(kind)) {
    return null
  }
  const quoted = SUMMARY.exec(notice)?.[1]?.trim()
  if (quoted) {
    return quoted
  }
  if (!isAgentChildWorkKind(kind)) {
    return null
  }
  return TASK_ID.exec(notice)?.[1]?.trim() || null
}

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
  const label = notice ? agentLabel(notice) : null
  const state = notice && label ? noticeState(STATUS.exec(notice)?.[1]?.trim() ?? '') : null
  if (!notice || !id || !label || !state) {
    return null
  }
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
