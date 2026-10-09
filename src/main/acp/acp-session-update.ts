import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import {
  boundInlineText,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import { acpWindowUsage } from './acp-context-usage'
import type { AcpDialect } from './acp-dialects/acp-dialect'
import type { AcpBackgroundTaskTimeline } from './acp-background-task-timeline'
import type { AcpSubagentTimeline } from './acp-subagent-timeline'
import type { AcpToolTimeline } from './acp-tool-timeline'
import type { SessionNotification } from './generated/acp-protocol.generated'
import { acpNamedTextKey } from './acp-turn-messages'

export function acpSessionUpdate(
  notification: SessionNotification,
  turn: string | undefined,
  at: number,
  context: {
    tools: AcpToolTimeline
    dialect: AcpDialect
    backgroundTasks: AcpBackgroundTaskTimeline
    subagents: AcpSubagentTimeline
    messageKey?: string
  }
): ProviderTimelineEvent[] {
  const update = notification.update
  const join = { join: { thread: notification.sessionId, ...(turn === undefined ? {} : { turn }) } }
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk': {
      const channel = update.sessionUpdate === 'agent_thought_chunk' ? 'reasoning' : 'assistant'
      return update.content.type === 'text'
        ? [
            {
              type: 'text.delta',
              item: context.messageKey
                ? { id: context.messageKey }
                : update.messageId
                  ? { id: acpNamedTextKey(update.messageId, channel) }
                  : { stream: update.sessionUpdate },
              channel,
              text: update.content.text,
              ...join
            }
          ]
        : [{ type: 'provider.frame', frameKind: update.sessionUpdate, payload: update, ...join }]
    }
    case 'user_message_chunk':
      // A live echo of the send is the send's own row.
      return []
    case 'tool_call':
    case 'tool_call_update': {
      const { tools, dialect, backgroundTasks, subagents } = context
      const events = tools.translate(update, dialect, join.join)
      const tool = events[0]
      const body = tool && 'body' in tool && tool.body?.kind === 'tool-call' ? tool.body : null
      const subagentUpdates = body ? (dialect.toolSubagents?.(update, body) ?? []) : []
      // Runs first, so a subagent this call reveals is never also taken for a background task.
      const subagentEvents = subagents.translate(subagentUpdates, join.join, at)
      const tasks = (body ? (dialect.toolBackgroundTasks?.(update, body) ?? []) : []).filter(
        (task) => !subagents.has(task.taskId)
      )
      return [...events, ...backgroundTasks.translate(tasks, join.join), ...subagentEvents]
    }
    case 'plan':
      return [
        {
          type: 'item.update',
          item: `plan:${turn ?? 'thread'}`,
          body: {
            kind: 'status',
            presentation: 'plan-document',
            text: boundInlineText(
              update.entries
                .map(
                  (entry) =>
                    `- [${entry.status === 'completed' ? 'x' : entry.status === 'in_progress' ? '~' : ' '}] ${entry.content}`
                )
                .join('\n'),
              DEFAULT_JOURNAL_PAYLOAD_LIMITS
            ).text
          },
          ...join
        }
      ]
    case 'usage_update':
      return [{ type: 'context.usage', usage: acpWindowUsage(update, at), ...join }]
    case 'available_commands_update':
    case 'current_mode_update':
    case 'config_option_update':
    case 'session_info_update':
      // These feed commands, options and the session title, outside the timeline.
      return []
    case 'plan_update':
    case 'plan_removed':
    case 'compaction_update':
    case 'compaction_summary_chunk':
      return [{ type: 'provider.frame', frameKind: update.sessionUpdate, payload: update, ...join }]
  }
}
