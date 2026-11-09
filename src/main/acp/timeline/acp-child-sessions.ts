// Subagents that report as child sessions of the root; their rows never open, end or join root turns.

import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalProducerLinkage
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type {
  ProviderTimelineEvent,
  ProviderTimelineJoin,
  ProviderTimelineTextItem
} from '../../native-chat/agent-session-timeline/provider-timeline-event'
import { z } from 'zod'
import type {
  AcpChildSessionReport,
  AcpDialect,
  AcpDialectNotification
} from '../acp-dialects/acp-dialect'
import type { SessionNotification } from '../generated/acp-protocol.generated'
import { acpNotificationEnvelopeSchema } from '../protocol/acp-session-events'
import { acpSubagentOutcome, type AcpSubagents } from './acp-subagents'
import type { AcpToolTimeline } from './acp-tool-timeline'
import { acpNamedTextKey } from './acp-turn-messages'

const sessionSchema = z.object({ sessionId: z.string() })

export class AcpChildSessions {
  /** ACP has no message end, so each child's text stays open until the child ends. */
  private readonly openText = new Map<string, Map<string, ProviderTimelineTextItem>>()

  constructor(
    private readonly rootSessionId: string,
    private readonly dialect: AcpDialect,
    private readonly subagents: AcpSubagents,
    private readonly tools: AcpToolTimeline
  ) {}

  /** A child session's events, or undefined when the notification is the root's own. */
  notification(
    method: string,
    params: unknown,
    extension: AcpDialectNotification | undefined,
    loading: boolean,
    /** The open root turn, where a newly seen subagent is announced. */
    turn: string | undefined,
    at: number
  ): ProviderTimelineEvent[] | undefined {
    const session = sessionSchema.safeParse(params)
    if (session.success && session.data.sessionId !== this.rootSessionId) {
      // A child that notifies on its own session supplies only its outcome.
      const id = session.data.sessionId
      const child = acpNotificationEnvelopeSchema.safeParse(params)
      if (loading || !this.subagents.has(id) || !child.success || child.data._meta?.isReplay) {
        return []
      }
      const state = this.dialect.subagentSessionEnd?.(method, params)
      return state ? this.subagents.reconcile(id, state, this.rootSessionId, at) : []
    }
    if (extension?.disposition !== 'map' || !extension.child) {
      return undefined
    }
    return extension.replay || loading ? [] : this.report(extension.child, turn, at)
  }

  private report(
    child: AcpChildSessionReport,
    turn: string | undefined,
    at: number
  ): ProviderTimelineEvent[] {
    const { rootSessionId, subagents } = this
    if (child.rootSessionId !== rootSessionId) {
      return []
    }
    // Plain frames for a known child carry no lifecycle, so they publish no evidence.
    const events =
      subagents.has(child.agentId) && child.state === undefined
        ? []
        : subagents.translate(
            [
              {
                id: child.agentId,
                state: child.state ?? 'working',
                ...(child.label ? { label: child.label } : {}),
                ...(child.started ? { restart: true as const } : {}),
                ...(child.parentAgentId ? { ownerId: child.parentAgentId } : {})
              }
            ],
            { thread: rootSessionId, ...(turn === undefined ? {} : { turn }) },
            at
          )
    if (child.update) {
      events.push(
        ...this.frame(child.update, {
          agentId: child.agentId,
          producerKind: 'agent',
          ...(child.parentAgentId ? { parentAgentId: child.parentAgentId } : {})
        })
      )
    }
    if (child.state !== undefined && acpSubagentOutcome(child.state) !== undefined) {
      events.push(...this.closeText(child.agentId))
    }
    return events
  }

  /** Messages and tools only; a child's plans, usage and commands are not the root's. */
  private frame(
    notification: SessionNotification,
    producer: AgentJournalProducerLinkage & { agentId: string }
  ): ProviderTimelineEvent[] {
    const join = { thread: notification.sessionId }
    // Thread scope keeps child rows writable after the turn that spawned them settles.
    const placed: ProviderTimelineJoin = { ...join, scope: AGENT_JOURNAL_THREAD_SCOPE }
    const update = notification.update
    let events: ProviderTimelineEvent[]
    if (
      update.sessionUpdate === 'agent_message_chunk' ||
      update.sessionUpdate === 'agent_thought_chunk'
    ) {
      if (update.content.type !== 'text') {
        return []
      }
      const channel = update.sessionUpdate === 'agent_thought_chunk' ? 'reasoning' : 'assistant'
      const item = update.messageId
        ? { id: acpNamedTextKey(update.messageId, channel) }
        : { stream: `${producer.agentId}:${update.sessionUpdate}` }
      const open = this.openText.get(producer.agentId) ?? new Map()
      open.set('id' in item ? item.id : item.stream, item)
      this.openText.set(producer.agentId, open)
      events = [{ type: 'text.delta', item, channel, text: update.content.text }]
    } else if (
      update.sessionUpdate === 'tool_call' ||
      update.sessionUpdate === 'tool_call_update'
    ) {
      // An unscoped join keeps partial tool context between updates.
      events = this.tools.translate(update, this.dialect, join)
    } else {
      return []
    }
    return events.map((event) =>
      event.type === 'item.open' ||
      event.type === 'item.update' ||
      event.type === 'item.close' ||
      event.type === 'text.delta'
        ? { ...event, join: placed, producer }
        : event.type === 'provider.frame'
          ? { ...event, join: placed }
          : event
    )
  }

  private closeText(agentId: string): ProviderTimelineEvent[] {
    const open = this.openText.get(agentId)
    this.openText.delete(agentId)
    const join = { thread: this.rootSessionId, scope: AGENT_JOURNAL_THREAD_SCOPE }
    return [...(open?.values() ?? [])].map((item) => ({ type: 'text.close', item, join }))
  }
}
