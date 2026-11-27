import { expect, it } from 'vitest'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalRenderItem
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { resolveJournalTimelineItem } from '../../../native-chat/agent-session-journal/writing/journal-timeline-resolution'
import { journalTimelineItemsView } from '../../../native-chat/agent-session-journal/writing/journal-timeline-view'
import { storedItemBody } from '../../../native-chat/agent-session-journal/durable-rows/journal-storage-schema'
import { isAdmissibleAgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-schemas'
import { projectStructuredItemToNativeChat } from '../../../../shared/agent-session/view/structured-agent-session-projection'

function conversation() {
  const rows = new Map<string, AgentJournalRenderItem>()
  const view = journalTimelineItemsView(
    (key) => rows.get(key) ?? null,
    () => rows.values()
  )
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity, body) => {
      const itemId = agentJournalItemKey(identity)
      const saved = rows.get(itemId)
      rows.set(itemId, {
        itemId,
        body,
        revision: (saved?.revision ?? 0) + 1,
        sequence: saved?.sequence ?? rows.size + 1,
        observedAt: 1
      })
    },
    appendTombstone: () => {},
    publish: () => {},
    tryReviseResolvedItem: (bytes, resolution) => {
      const result = resolveJournalTimelineItem(view, resolution, AGENT_JOURNAL_THREAD_SCOPE, bytes)
      if (result.kind === 'resolved') {
        sink.appendItem(result.item.identity, result.item.body, {
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        })
      }
      return { accepted: true }
    }
  }
  const translator = createCodexJournalTranslator({
    sink,
    primaryThreadId: () => 'thread',
    now: () => 1
  })
  const send = (method: string, params: Record<string, unknown>) =>
    translator.handle({
      type: 'notification',
      sessionId: 's',
      threadId: 'thread',
      method,
      params: { threadId: 'thread', turnId: 'turn', ...params }
    })
  const answer = (id: string) =>
    send('item/completed', { item: { id, type: 'agentMessage', text: id } })
  const usage = (inputTokens: number, outputTokens: number) =>
    send('thread/tokenUsage/updated', {
      tokenUsage: {
        total: { inputTokens: 999_000, outputTokens: 999_000 },
        last: {
          inputTokens,
          cachedInputTokens: 4,
          outputTokens,
          totalTokens: inputTokens + outputTokens
        },
        modelContextWindow: 100
      }
    })
  const restored = () =>
    [...rows.values()]
      .map((row) => {
        const body: unknown = storedItemBody.parse(JSON.parse(JSON.stringify(row.body)))
        if (!isAdmissibleAgentJournalItemBody(body)) {
          throw new Error('Unreadable journal body')
        }
        return projectStructuredItemToNativeChat({ ...row, body })
      })
      .filter((row) => row?.role === 'assistant')
  return { answer, usage, restored }
}

it('keeps each answer’s own request usage through journal replay without substituting session totals', () => {
  const chat = conversation()
  chat.answer('first')
  chat.usage(10, 2)
  chat.answer('second')
  chat.usage(20, 3)
  const messages = chat.restored()
  expect(messages.map((message) => message?.usage)).toEqual([
    { inputTokens: 6, cacheReadInputTokens: 4, cacheCreationInputTokens: 0, outputTokens: 2 },
    { inputTokens: 16, cacheReadInputTokens: 4, cacheCreationInputTokens: 0, outputTokens: 3 }
  ])
  expect(messages.map((message) => message?.usageContext?.used)).toMatchObject([
    { kind: 'report', usedTokens: 12, windowTokens: 100 },
    { kind: 'report', usedTokens: 23, windowTokens: 100 }
  ])
  expect(messages.map((message) => message?.blocks)).toEqual([
    [{ type: 'text', text: 'first' }],
    [{ type: 'text', text: 'second' }]
  ])
})

it('leaves ambiguous or absent accounting unknown instead of charging one request to multiple messages', () => {
  const chat = conversation()
  chat.answer('first')
  chat.answer('second')
  chat.usage(10, 2)
  chat.answer('without-usage')
  expect(chat.restored().map((message) => message?.usage)).toEqual([
    undefined,
    undefined,
    undefined
  ])
})
