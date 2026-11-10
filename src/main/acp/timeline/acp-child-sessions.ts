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

const textKey = (item: ProviderTimelineTextItem): string => ('id' in item ? item.id : item.stream)

const sessionSchema = z.object({ sessionId: z.string() })

export class AcpChildSessions {
  /** ACP has no message end; a child's text closes at the next message on its channel, or when it ends. */
  private readonly openText = new Map<string, ProviderTimelineTextItem>()
  /** Children that have not reported an ending, which a user's Stop also ends. */
  private readonly running = new Set<string>()
  /** Live children whose execution has started, so closing their session interrupts it. */
  private readonly executing = new Set<string>()

  constructor(
    private readonly rootSessionId: string,
    private readonly dialect: AcpDialect,
    private readonly subagents: AcpSubagents,
    private readonly tools: AcpToolTimeline
  ) {}

  live(): readonly string[] {
    return [...this.running]
  }

  started(id: string): boolean {
    return this.executing.has(id)
  }

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
    const known = subagents.has(child.agentId)
    // Plain frames for a known child carry no lifecycle, so they publish no evidence.
    const events =
      known && child.state === undefined
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
    if (child.state === undefined || acpSubagentOutcome(child.state) === undefined) {
      if (child.state !== undefined || !known) {
        this.running.add(child.agentId)
      }
      // A child seen mid-run (its start came before this process) is executing too.
      if ((child.started || child.update) && this.running.has(child.agentId)) {
        this.executing.add(child.agentId)
      }
    } else {
      this.running.delete(child.agentId)
      this.executing.delete(child.agentId)
      events.push(
        ...this.closeText(`${child.agentId}:assistant`),
        ...this.closeText(`${child.agentId}:reasoning`)
      )
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
      // OpenCode keeps one fragment per channel open, so only a new message on the same channel ends one.
      const slot = `${producer.agentId}:${channel}`
      const open = this.openText.get(slot)
      events = [
        ...(open === undefined || textKey(open) === textKey(item) ? [] : this.closeText(slot)),
        { type: 'text.delta', item, channel, text: update.content.text }
      ]
      this.openText.set(slot, item)
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

  private closeText(slot: string): ProviderTimelineEvent[] {
    const item = this.openText.get(slot)
    this.openText.delete(slot)
    const join = { thread: this.rootSessionId, scope: AGENT_JOURNAL_THREAD_SCOPE }
    return item ? [{ type: 'text.close', item, join }] : []
  }
}
