import { afterEach, expect, it, vi } from 'vitest'
import { createClaudeJournalTranslator } from '../../../../../claude/structured/journal/claude-structured-journal-translation'
import { createCodexStructuredItemStreams } from '../../../../../codex/structured/items/codex-structured-item-streams'
import type { AgentJournalItemBody } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../../../journal-ingress/structured-agent-session-event-sink'

afterEach(() => vi.useRealTimers())

function producer(agent: 'claude' | 'codex', role: 'assistant' | 'reasoning') {
  const saves: { text: string; at: number }[] = []
  let appendAccepted = true
  let publicationAccepted = true
  const appendItem = vi.fn<StructuredAgentSessionEventSink['appendItem']>((_id, body) =>
    record(body)
  )
  const sink: StructuredAgentSessionEventSink = {
    appendItem,
    appendTombstone: () => {},
    publish: () => {},
    tryAppendItem: (identity, body, options) => {
      if (!appendAccepted) {
        return { accepted: false, reason: 'backpressure' }
      }
      appendItem(identity, body, options)
      return { accepted: true }
    },
    tryPublish: () =>
      publicationAccepted ? { accepted: true } : { accepted: false, reason: 'backpressure' }
  }
  function record(body: AgentJournalItemBody) {
    if (body.kind === 'message' && body.role === role) {
      saves.push({
        text: body.blocks.flatMap((b) => (b.type === 'text' ? b.text : [])).join(''),
        at: performance.now()
      })
    }
  }
  const claude = createClaudeJournalTranslator({ sink })
  claude.handle({
    type: 'message',
    sessionId: 'session',
    message: {
      type: 'stream_event',
      session_id: 'provider',
      uuid: 'frame',
      event: { type: 'message_start', message: { id: 'reply' } }
    }
  })
  const codex = createCodexStructuredItemStreams({
    sink,
    turnIdFor: () => 'turn',
    identityFor: () => ({
      provider: 'codex',
      threadId: 'thread',
      turnId: 'turn',
      ordinal: 0
    }),
    attributionFor: () => ({ turnScope: { kind: 'thread' } })
  })
  const delta = (text: string) => {
    if (agent === 'codex') {
      codex.handle(
        'thread',
        role === 'assistant' ? 'item/agentMessage/delta' : 'item/reasoning/textDelta',
        { itemId: 'reply', delta: text }
      )
    } else {
      claude.handle({
        type: 'message',
        sessionId: 'session',
        observedAt: Date.now(),
        message: {
          type: 'stream_event',
          session_id: 'provider',
          uuid: 'frame',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta:
              role === 'assistant'
                ? { type: 'text_delta', text }
                : { type: 'thinking_delta', thinking: text }
          }
        }
      })
    }
  }
  return {
    saves,
    appendItem,
    codex,
    delta,
    refuse: (append: boolean, publish: boolean) => {
      appendAccepted = !append
      publicationAccepted = !publish
    },
    flush: () => (agent === 'codex' ? codex.flush() : claude.flush()),
    dispose: () => {
      claude.dispose()
      codex.dispose()
    }
  }
}

it.each(['claude', 'codex'] as const)(
  '%s uses elapsed admission, preserves pause tails at real barriers and ignores wall rollback',
  (agent) => {
    for (const role of ['assistant', 'reasoning'] as const) {
      vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
      vi.setSystemTime(500000)
      const r = producer(agent, role)
      r.delta('P')
      vi.advanceTimersByTime(59)
      expect(r.saves).toEqual([])
      vi.advanceTimersByTime(1)
      expect(r.saves).toEqual([{ text: 'P', at: 60 }])
      vi.advanceTimersByTime(40)
      r.delta('T'.repeat(200))
      vi.advanceTimersByTime(60)
      expect(r.saves).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(0)
      vi.advanceTimersByTime(300)
      expect(r.saves).toHaveLength(1)
      vi.setSystemTime(100)
      r.delta('U')
      vi.advanceTimersByTime(60)
      expect(r.saves.at(-1)).toEqual({ text: `P${'T'.repeat(200)}U`, at: 520 })
      r.delta(' tail')
      vi.advanceTimersByTime(60)
      expect(r.saves).toHaveLength(2)
      r.flush()
      expect(r.saves.at(-1)?.text).toBe(`P${'T'.repeat(200)}U tail`)
      r.dispose()
      vi.useRealTimers()
    }
  }
)

it.each(['claude', 'codex'] as const)(
  '%s does not spend first eligibility on no-body or refused publication',
  (agent) => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
    const r = producer(agent, 'reasoning')
    r.delta(' \n ')
    vi.advanceTimersByTime(60)
    expect(r.saves).toEqual([])
    r.refuse(false, true)
    r.delta('P')
    vi.advanceTimersByTime(60)
    expect(r.saves.at(-1)?.text).toBe(' \n P')
    r.refuse(false, false)
    r.delta('T')
    vi.advanceTimersByTime(60)
    expect(r.saves.at(-1)).toEqual({ text: ' \n PT', at: 180 })
    r.dispose()
  }
)

it('Claude observes append refusal without adding an autonomous cross-turn retry', () => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
  const r = producer('claude', 'assistant')
  r.refuse(true, false)
  r.delta('P')
  vi.advanceTimersByTime(60)
  expect(r.saves).toEqual([])
  expect(vi.getTimerCount()).toBe(0)
  r.refuse(false, false)
  vi.advanceTimersByTime(1000)
  expect(r.saves).toEqual([])
  r.delta('T')
  vi.advanceTimersByTime(60)
  expect(r.saves.at(-1)?.text).toBe('PT')
  r.dispose()
})
