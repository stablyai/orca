import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import {
  createCodexHistoryTranslator,
  createCodexJournalTranslator
} from './codex-structured-journal-translation'

function setup() {
  const rows = new Map<string, AgentJournalItemBody>()
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity, body) => {
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
  return { rows, sink, translator, send }
}

describe('compaction provider generation compatibility', () => {
  it.each(['append', 'publish'])('does not suppress the retry after rejected %s', (stage) => {
    const { rows, sink, translator, send } = setup()
    let reject = true
    let publishes = 0
    sink.tryAppendItem = (identity, body) => {
      if (stage === 'append' && reject) {
        return { accepted: false, reason: 'backpressure' }
      }
      sink.appendItem(identity, body, { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
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

  it('restores canonical compaction history over a previously journaled legacy fallback', () => {
    const { rows, sink, translator, send } = setup()
    send('thread/compacted')
    translator.dispose()
    const restored = createCodexHistoryTranslator({ sink })
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
