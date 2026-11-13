import type { AgentJournalItemIdentity } from '../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalProducerLinkage } from '../../shared/agent-session/journal/agent-session-journal-types'
import { createProviderTimelineAssembler } from '../native-chat/agent-session-timeline/provider-timeline-assembler'
import { createLegacyProviderTimelineIdentityScheme } from '../native-chat/agent-session-timeline/provider-timeline-identity'
import { providerTimelineSink } from '../native-chat/agent-session-timeline/provider-timeline-plan'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import type { StructuredAgentSessionCommandRun } from '../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { traexItemSchema, traexRecord, traexText } from './traex-protocol'
import { traexItemBody } from './traex-item-translation'
import { createTraexTimelineItemKeyResolver } from './traex-timeline-item-key'
import { TraexStreamItems } from './traex-stream-items'
import { TraexGoalTimeline } from './traex-goal-timeline'
import { readTraexContextUsage } from './traex-context-usage'
import { normalizeNativeChatTaskList } from '../../shared/native-chat/input/native-chat-task-list'
import { traexFailureNotice, traexNotificationNotice } from './traex-turn-notices'

export class TraexTimeline {
  private readonly assembler
  private readonly backlog: { event: ProviderTimelineEvent; admitted?: () => void }[] = []
  private readonly identity
  private readonly itemKey
  private readonly goals
  private readonly streams
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private failed = false
  private retainedBytes = 0
  private noticeSequence = 0

  constructor(
    private readonly deps: {
      sessionId: string
      threadId: string
      generation: string
      primaryThreadId?: string
      producer?: AgentJournalProducerLinkage
      sink: StructuredAgentSessionEventSink
      fail: (error: Error) => void
    }
  ) {
    const sink = providerTimelineSink(deps.sink)
    if (!sink) {
      throw new Error('TRAE CLI chats require a journal sink')
    }
    if (deps.producer) {
      delete sink.setActivity
    }
    this.itemKey = createTraexTimelineItemKeyResolver({
      sessionId: deps.sessionId,
      threadId: deps.threadId,
      journal: () => sink.journalItems?.()
    })
    this.identity = createLegacyProviderTimelineIdentityScheme({
      agent: 'trae',
      sessionId: deps.sessionId
    })
    this.goals = new TraexGoalTimeline({
      threadId: deps.threadId,
      journal: () => sink.journalItems(),
      apply: (event) => this.apply(event)
    })
    this.assembler = createProviderTimelineAssembler({
      sink,
      sessionId: deps.sessionId,
      agent: 'trae',
      generation: deps.generation,
      namespace: deps.threadId,
      ownThread: () => deps.primaryThreadId ?? deps.threadId
    })
    this.streams = new TraexStreamItems({
      threadId: deps.threadId,
      includeUserMessages: !!deps.producer,
      itemKey: this.itemKey,
      apply: (event) => this.apply(event),
      failed: () => this.failed
    })
  }

  get openTurnId(): string | null {
    return this.assembler.openTurnId
  }

  beginCommand(command: StructuredAgentSessionCommandRun): void {
    this.assembler.beginCommand(command)
  }

  observeGoal(method: string, value: unknown): void {
    this.goals.observe(method, value)
  }

  observeContext(value: unknown, turn?: string): void {
    if (this.deps.producer) {
      return
    }
    const usage = readTraexContextUsage(value, this.deps.threadId)
    if (usage) {
      this.apply({
        type: 'context.usage',
        usage,
        ...(turn ? { join: { thread: this.deps.threadId, turn } } : {})
      })
    }
  }

  turnIdentity(turn: string): AgentJournalItemIdentity {
    return this.identity.turn({
      namespace: this.deps.threadId,
      key: { source: 'provider', value: turn }
    })
  }

  completeTurn(value: unknown, turn: string): void {
    const completed = traexRecord(value)
    if (completed.status === 'failed') {
      this.apply({
        type: 'item.update',
        item: this.itemKey(turn, 'turn-error'),
        body: traexFailureNotice({
          threadId: this.deps.threadId,
          turnId: turn,
          error: completed.error
        }),
        join: { thread: this.deps.threadId, turn }
      })
    }
  }

  requestItemId(key: string): AgentJournalItemIdentity {
    return this.identity.request({ generation: this.deps.generation, key, incarnation: 1 })
  }

  apply(event: ProviderTimelineEvent, admitted?: () => void): void {
    if (this.failed) {
      return
    }
    if (
      this.deps.producer &&
      (event.type === 'item.open' ||
        event.type === 'item.update' ||
        event.type === 'item.close' ||
        event.type === 'text.delta' ||
        event.type === 'request.open')
    ) {
      event = { ...event, producer: this.deps.producer }
    }
    const bytes = Buffer.byteLength(JSON.stringify(event), 'utf8')
    if (this.backlog.length >= 512 || this.retainedBytes + bytes > 32 * 1024 * 1024) {
      this.failed = true
      this.deps.fail(new Error('TRAE CLI timeline backlog exceeded its bound'))
      return
    }
    this.retainedBytes += bytes
    this.backlog.push({ event, admitted })
    this.drain()
  }

  notification(method: string, value: unknown, turn: string | null): void {
    const params = traexRecord(value)
    const threadId = traexText(params.threadId)
    if (threadId !== this.deps.threadId) {
      return
    }
    if (method === 'thread/tokenUsage/updated') {
      this.observeContext(params, turn ?? undefined)
      return
    }
    const notice = traexNotificationNotice(method, params)
    if (notice) {
      this.apply({
        type: method === 'error' ? 'item.update' : 'item.close',
        item:
          turn && method === 'error'
            ? this.itemKey(turn, 'turn-error')
            : `notice:${this.deps.generation}:${++this.noticeSequence}`,
        body: notice,
        join: turn ? { thread: threadId, turn } : { thread: threadId, scope: { kind: 'thread' } }
      })
      return
    }
    if (!turn) {
      const item = traexItemSchema.safeParse(params.item)
      if (item.success && item.data.type === 'taskNotification') {
        const body = traexItemBody(item.data, true)
        if (body) {
          this.apply({
            type: 'item.close',
            item: this.itemKey('notification', item.data.id),
            body,
            join: { thread: threadId, scope: { kind: 'thread' } }
          })
        }
      }
      return
    }
    const join = { thread: threadId, turn }
    if (method === 'thread/compacted') {
      this.apply({
        type: 'item.close',
        item: this.itemKey(turn, 'contextCompaction'),
        body: { kind: 'status', text: 'Context compacted', presentation: 'compaction' },
        join: { thread: threadId, scope: { kind: 'thread' } }
      })
      return
    }
    if (method === 'turn/plan/updated' && normalizeNativeChatTaskList('update_plan', params)) {
      this.apply({
        type: 'item.close',
        item: this.itemKey(turn, `task-plan:${++this.noticeSequence}`),
        body: {
          kind: 'tool-call',
          name: 'update_plan',
          input: { plan: params.plan, explanation: params.explanation },
          state: 'completed'
        },
        join
      })
      return
    }
    if (this.streams.notification(method, params, turn)) {
      return
    }
    if (method === 'queue/status') {
      if (this.deps.producer) {
        return
      }
      this.apply({
        type: 'activity',
        text:
          params.state === 'ready'
            ? null
            : `Queued${typeof params.position === 'number' ? ` (position ${params.position})` : ''}`
      })
      return
    }
    if (
      ![
        'thread/status/changed',
        'thread/settings/updated',
        'thread/queue/changed',
        'thread/inboxStatus/updated',
        'thread/tokenUsage/updated',
        'item/reasoning/summaryPartAdded',
        'item/mcpToolCall/progress',
        'rawResponse/completed'
      ].includes(method)
    ) {
      this.apply({
        type: 'provider.frame',
        frameKind: `notification:${method}`,
        payload: params,
        join
      })
    }
  }

  retry(): void {
    this.drain()
  }

  flush(): void {
    this.streams.flush()
    this.assembler.flush()
  }

  dispose(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
    }
    this.streams.dispose()
    this.assembler.dispose()
    this.backlog.length = 0
    this.failed = true
  }

  private drain(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
    }
    this.retryTimer = null
    while (this.backlog.length && !this.failed) {
      const next = this.backlog[0]!
      const { admission } = this.assembler.apply(next.event)
      if (!admission.accepted) {
        if (admission.reason !== 'backpressure') {
          this.failed = true
          this.deps.fail(new Error(`TRAE CLI journal refused a write: ${admission.reason}`))
        } else {
          this.retryTimer = setTimeout(() => this.drain(), 25)
          this.retryTimer.unref()
        }
        return
      }
      this.backlog.shift()
      this.retainedBytes -= Buffer.byteLength(JSON.stringify(next.event), 'utf8')
      next.admitted?.()
    }
  }
}
