import type { ProviderTimelineEvent } from '../../native-chat/agent-session-timeline/provider-timeline-event'
import { acpWindowUsage } from './acp-context-usage'
import type { AcpDialect } from '../acp-dialects/acp-dialect'
import type { AcpBackgroundTaskTimeline } from './acp-background-task-timeline'
import type { AcpSubagents } from './acp-subagents'
import type { AcpTurnFailures } from './acp-turn-failures'
import type { AgentJournalTurnScope } from '../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import type { AcpToolTimeline } from './acp-tool-timeline'
import type { SessionNotification } from '../generated/acp-protocol.generated'
import { acpNamedTextKey } from './acp-turn-messages'

/** Updates that open the turn they belong to. */
export const ACP_SUBSTANTIVE_UPDATES = [
  'user_message_chunk',
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'plan'
]

export function acpSessionUpdate(
  notification: SessionNotification,
  turn: string | undefined,
  at: number,
  context: {
    tools: AcpToolTimeline
    dialect: AcpDialect
    backgroundTasks: AcpBackgroundTaskTimeline
    subagents: AcpSubagents
    failures: AcpTurnFailures
    messageKey?: string
    scope?: AgentJournalTurnScope
  }
): ProviderTimelineEvent[] {
  const update = notification.update
  const join = {
    join: {
      thread: notification.sessionId,
      ...(turn === undefined ? {} : { turn }),
      ...(context.scope ? { scope: context.scope } : {})
    }
  }
  const retry = context.failures.retry(update, turn, at, join.join)
  if (retry) {
    return retry
  }
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
              join: {
                ...join.join,
                ...(update.messageId
                  ? {
                      scopeItems: [
                        acpNamedTextKey(update.messageId, 'assistant'),
                        acpNamedTextKey(update.messageId, 'reasoning')
                      ]
                    }
                  : {})
              }
            }
          ]
        : [{ type: 'provider.frame', frameKind: update.sessionUpdate, payload: update, ...join }]
    }
    case 'user_message_chunk':
      // The original send already owns a journal row.
      return []
    case 'tool_call':
    case 'tool_call_update': {
      const { tools, dialect, backgroundTasks, subagents } = context
      const backgrounded = tools.backgroundTask(update, dialect, at)
      if (backgrounded) {
        return backgroundTasks.translate([backgrounded], join.join)
      }
      const events = tools.translate(update, dialect, join.join)
      const tool = events[0]
      const body = tool && 'body' in tool && tool.body?.kind === 'tool-call' ? tool.body : null
      const call = body ? tools.wholeCall(update.toolCallId, body) : null
      const subagentUpdates = call ? (dialect.toolSubagents?.(update, call) ?? []) : []
      // Register subagents before excluding them from background tasks.
      const subagentEvents = subagents.translate(subagentUpdates, join.join, at)
      const tasks = (call ? (dialect.toolBackgroundTasks?.(update, call) ?? []) : []).filter(
        (task) => !subagents.has(task.taskId)
      )
      const planText = call ? dialect.toolPlan?.(update, call)?.trim() : undefined
      const planEvents: ProviderTimelineEvent[] = planText
        ? [
            {
              type: 'item.update',
              item: `plan-tool:${update.toolCallId}`,
              body: {
                kind: 'status',
                presentation: 'plan-document',
                text: planText
              },
              ...join
            }
          ]
        : []
      return [
        ...events,
        ...planEvents,
        ...backgroundTasks.translate(tasks, join.join),
        ...subagentEvents
      ]
    }
    case 'plan':
      return [
        {
          type: 'item.update',
          item: `plan:${turn ?? 'thread'}`,
          body: {
            kind: 'status',
            presentation: 'plan-document',
            text: update.entries
              .map(
                (entry) =>
                  `- [${entry.status === 'completed' ? 'x' : entry.status === 'in_progress' ? '~' : ' '}] ${entry.content}`
              )
              .join('\n')
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
      // Options, commands and titles update outside the timeline.
      return []
    case 'plan_update':
    case 'plan_removed':
    case 'compaction_update':
    case 'compaction_summary_chunk':
      return [{ type: 'provider.frame', frameKind: update.sessionUpdate, payload: update, ...join }]
  }
}
