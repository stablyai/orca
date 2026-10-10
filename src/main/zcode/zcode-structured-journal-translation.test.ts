import { describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createZcodeJournalTranslator } from './zcode-structured-journal-translation'
import type { ZcodeSessionEvent } from './zcode-protocol-events'

const SESSION_ID = 'session-1'

type Row = { key: string; body: AgentJournalItemBody }

function recorder() {
  const rows: Row[] = []
  let publishes = 0
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity: AgentJournalItemIdentity, body) =>
      rows.push({ key: agentJournalItemKey(identity), body }),
    appendTombstone: () => {},
    publish: () => {
      publishes += 1
    },
    tryPublish: () => {
      publishes += 1
      return { accepted: true }
    }
  }
  return { sink, rows, publishes: () => publishes }
}

/** Fires the coalescing window on demand instead of on wall time. */
function manualWindow() {
  const pending: (() => void)[] = []
  return {
    schedule: (run: () => void) => {
      pending.push(run)
      return () => {
        const index = pending.indexOf(run)
        if (index !== -1) {
          pending.splice(index, 1)
        }
      }
    },
    fire: () => {
      const due = pending.splice(0)
      for (const run of due) {
        run()
      }
    }
  }
}

function event(type: string, payload: Record<string, unknown>, seq = 1): ZcodeSessionEvent {
  return {
    type,
    sessionId: SESSION_ID,
    ...(typeof payload.turnId === 'string' ? { turnId: payload.turnId } : {}),
    seq,
    timestamp: 1_700_000_000_000,
    payload
  }
}

const TURN_STARTED = event('turn.started', { turnId: 'turn-1' })

function translatorWith(tap = recorder(), window = manualWindow()) {
  const translator = createZcodeJournalTranslator({
    sessionId: SESSION_ID,
    sink: tap.sink,
    now: () => 0,
    schedule: window.schedule
  })
  return { translator, tap, window }
}

const messageKey = (messageId: string): string =>
  agentJournalItemKey({
    provider: 'legacy',
    agent: 'zcode',
    sessionId: '',
    recordId: `message:${messageId}`
  })

const streaming = (messageId: string, delta: string, kind = 'text_delta', seq = 2) =>
  event(
    'model.streaming',
    // The wire shape: envelope fields outside, the delta fields inside `payload`.
    { payload: { assistantMessageId: messageId, delta, kind, done: false } },
    seq
  )

describe('zcode journal translation: model.streaming', () => {
  it('accumulates text deltas into a running assistant row and closes it at turn end', () => {
    const { translator, tap, window } = translatorWith()
    expect(translator.handle(TURN_STARTED).accepted).toBe(true)
    expect(translator.handle(streaming('msg-1', '你')).accepted).toBe(true)
    expect(translator.handle(streaming('msg-1', '好', 'text_delta', 3)).accepted).toBe(true)
    window.fire()

    const running = tap.rows.find((row) => row.key === messageKey('msg-1'))
    expect(running?.body).toMatchObject({
      kind: 'message',
      role: 'assistant',
      state: 'running',
      blocks: [{ type: 'text', text: '你好' }]
    })

    expect(translator.handle(event('turn.completed', { turnId: 'turn-1' }, 4)).accepted).toBe(true)
    const completed = tap.rows.findLast((row) => row.key === messageKey('msg-1'))
    expect(completed?.body).toMatchObject({
      kind: 'message',
      role: 'assistant',
      state: 'completed',
      blocks: [{ type: 'text', text: '你好' }]
    })
    expect(tap.publishes()).toBeGreaterThan(0)
  })

  it('keys reasoning deltas onto their own reasoning row', () => {
    const { translator, tap, window } = translatorWith()
    translator.handle(TURN_STARTED)
    translator.handle(streaming('msg-1', '想想', 'reasoning_delta'))
    translator.handle(streaming('msg-1', '答案', 'text_delta', 3))
    window.fire()

    const reasoning = tap.rows.find(
      (row) => row.body.kind === 'message' && row.body.role === 'reasoning'
    )
    expect(reasoning?.body).toMatchObject({
      role: 'reasoning',
      state: 'running',
      blocks: [{ type: 'text', text: '想想' }]
    })
    const assistant = tap.rows.find(
      (row) => row.body.kind === 'message' && row.body.role === 'assistant'
    )
    expect(assistant?.body).toMatchObject({
      role: 'assistant',
      blocks: [{ type: 'text', text: '答案' }]
    })
  })

  it('ignores unknown delta kinds and a done frame with no text', () => {
    const { translator, tap, window } = translatorWith()
    translator.handle(TURN_STARTED)
    translator.handle(streaming('msg-1', 'x', 'tool_delta'))
    translator.handle(
      event(
        'model.streaming',
        { payload: { assistantMessageId: 'msg-1', delta: '', kind: 'text_delta', done: true } },
        3
      )
    )
    window.fire()
    const messageRows = tap.rows.filter((row) => row.body.kind === 'message')
    expect(messageRows).toEqual([])
  })

  it('keeps the last running snapshot on an unproven turn end', () => {
    const { translator, tap, window } = translatorWith()
    translator.handle(TURN_STARTED)
    translator.handle(streaming('msg-1', '写到一半'))
    window.fire()
    translator.endTurnUnproven('turn-1')

    const row = tap.rows.find((row) => row.key === messageKey('msg-1'))
    expect(row?.body).toMatchObject({
      state: 'running',
      blocks: [{ type: 'text', text: '写到一半' }]
    })
    // A later turn end writes no completion: the stream was forgotten.
    translator.handle(event('turn.completed', { turnId: 'turn-1' }, 3))
    expect(tap.rows.filter((row) => row.key === messageKey('msg-1'))).toHaveLength(1)
  })

  it('does not re-emit a running row below the checkpoint growth threshold', () => {
    const { translator, tap, window } = translatorWith()
    translator.handle(TURN_STARTED)
    translator.handle(streaming('msg-1', 'x'.repeat(40)))
    window.fire()
    const afterFirst = tap.rows.length

    translator.handle(streaming('msg-1', 'y'.repeat(8), 'text_delta', 3))
    window.fire()
    expect(tap.rows.length).toBe(afterFirst)
  })

  it('restores snapshot messages over a live stream copy', () => {
    const { translator, tap } = translatorWith()
    translator.handle(TURN_STARTED)
    translator.handle(streaming('msg-1', '部分'))
    translator.restoreSnapshot([
      {
        info: { messageId: 'msg-1', role: 'assistant' },
        parts: [{ type: 'text', text: '完整回复' }]
      }
    ])
    const row = tap.rows.find((row) => row.key === messageKey('msg-1'))
    expect(row?.body).toMatchObject({
      role: 'assistant',
      state: 'completed',
      blocks: [{ type: 'text', text: '完整回复' }]
    })
  })
})
