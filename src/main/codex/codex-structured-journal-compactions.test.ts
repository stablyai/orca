import { describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import { projectStructuredItemsToNativeChat } from '../../shared/structured-agent-session-projection'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  createCodexJournalTranslator,
  MAX_CODEX_GENERIC_TURN_BUCKETS
} from './codex-structured-journal-translation'

function setup() {
  const rows = new Map<string, AgentJournalItemBody>()
  let writes = 0
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity, body) => {
      writes += 1
      rows.set(agentJournalItemKey(identity), body)
    },
    appendTombstone: (identity) => rows.delete(agentJournalItemKey(identity)),
    publish: () => {}
  }
  const translator = createCodexJournalTranslator({ sink })
  const send = (method: string, turnId = 'turn', threadId = 'thread') =>
    translator.handle({
      type: 'notification',
      sessionId: 'session',
      threadId,
      method,
      params: { turnId, item: { id: `compact-${turnId}`, type: 'contextCompaction' } }
    })
  return { rows, sink, translator, send, writes: () => writes }
}

describe('compaction provider generation compatibility', () => {
  it.each([
    ['item/completed'],
    ['thread/compacted'],
    ['item/completed', 'thread/compacted'],
    ['thread/compacted', 'item/completed']
  ])('projects one readable divider for %j', (...methods) => {
    const { rows, translator, send } = setup()
    expect(send('item/started')).toEqual({ accepted: true })
    expect(rows.size).toBe(0)
    for (const method of methods) {
      expect(send(method)).toEqual({ accepted: true })
    }
    const messages = projectStructuredItemsToNativeChat(
      [...rows].map(([itemId, body], index) => ({
        itemId,
        body,
        sequence: index + 1,
        revision: 1,
        observedAt: 1
      }))
    )
    expect(messages).toHaveLength(1)
    expect(messages[0]?.blocks).toEqual([
      { type: 'text', text: 'Context compacted', presentation: 'compaction' }
    ])
    translator.dispose()
  })

  it('keeps the canonical item authoritative and scopes deduplication by thread and turn', () => {
    const { rows, translator, send, writes } = setup()
    send('thread/compacted')
    send('item/completed')
    expect(writes()).toBe(2)
    send('thread/compacted')
    send('item/completed')
    expect(writes()).toBe(2)
    send('item/completed', 'turn-2')
    send('item/completed', 'turn', 'other-thread')
    expect(rows.size).toBe(3)
    translator.dispose()
  })

  it.each(['append', 'publish'])('does not suppress the retry after rejected %s', (stage) => {
    const { rows, sink, translator, send } = setup()
    let reject = true
    let publishes = 0
    sink.tryAppendItem = (identity, body) => {
      if (stage === 'append' && reject) {
        return { accepted: false, reason: 'backpressure' }
      }
      sink.appendItem(identity, body)
      return { accepted: true }
    }
    sink.tryPublish = () => {
      publishes += 1
      return stage === 'publish' && reject
        ? { accepted: false, reason: 'backpressure' }
        : { accepted: true }
    }
    expect(send('item/completed')).toEqual({ accepted: false, reason: 'backpressure' })
    reject = false
    expect(send('item/completed')).toEqual({ accepted: true })
    expect(rows.size).toBe(1)
    expect(publishes).toBe(stage === 'publish' ? 2 : 1)
    translator.dispose()
  })

  it('bounds retained turns and keeps the same journal identity after eviction', () => {
    const { rows, translator, send, writes } = setup()
    send('item/completed', 'oldest')
    for (let index = 0; index < MAX_CODEX_GENERIC_TURN_BUCKETS; index += 1) {
      send('item/completed', `turn-${index}`)
    }
    const before = writes()
    send('thread/compacted', 'oldest')
    expect(writes()).toBe(before + 1)
    expect(rows.size).toBe(MAX_CODEX_GENERIC_TURN_BUCKETS + 1)
    translator.dispose()
  })

  it('restores canonical compaction history over a previously journaled legacy fallback', () => {
    const { rows, sink, translator, send } = setup()
    send('thread/compacted')
    translator.dispose()
    const restored = createCodexJournalTranslator({ sink })
    expect(
      restored.restoreThread('thread', {
        turns: [{ id: 'turn', items: [{ id: 'renumbered', type: 'contextCompaction' }] }]
      })
    ).toEqual({ accepted: true })
    expect(rows.size).toBe(1)
    expect([...rows.values()][0]).toEqual({
      kind: 'status',
      text: 'Context compacted',
      presentation: 'compaction'
    })
    restored.dispose()
  })
})
