// When the host says a Claude reasoning block is open: from its content_block_start, blank blocks
// included, until its final frame, its stop, a new message in its stream, or the turn's end.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionTurnActivity } from '../../shared/agent-session-wire'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'

type Entry =
  | { kind: 'row'; body: AgentJournalItemBody }
  | { kind: 'activity'; activity: AgentSessionTurnActivity | null }

function setup() {
  const log: Entry[] = []
  const translator = createClaudeJournalTranslator({
    sink: {
      appendItem: (_identity, body) => {
        if (body.kind === 'message' && body.role === 'reasoning') {
          log.push({ kind: 'row', body })
        }
      },
      appendTombstone: vi.fn(),
      publish: vi.fn(),
      setActivity: (activity) => log.push({ kind: 'activity', activity })
    }
  })
  const frame = (message: Record<string, unknown>, observedAt: number, parent?: string): void =>
    translator.handle({
      type: 'message',
      sessionId: 'orca-session',
      observedAt,
      message: { session_id: 'session', parent_tool_use_id: parent ?? null, ...message }
    })
  const stream = (
    uuid: string,
    event: Record<string, unknown>,
    observedAt: number,
    parent?: string
  ): void => frame({ type: 'stream_event', uuid, event }, observedAt, parent)
  const messageStart = (at: number, parent?: string, id = 'message-1'): void =>
    stream(`start-${at}`, { type: 'message_start', message: { id } }, at, parent)
  const blockStart = (at: number, parent?: string): void =>
    stream(
      `block-${at}`,
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      at,
      parent
    )
  const delta = (at: number, thinking: string): void =>
    stream(
      `delta-${at}`,
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } },
      at
    )
  const stop = (at: number): void =>
    stream(`stop-${at}`, { type: 'content_block_stop', index: 0 }, at)
  const final = (at: number, thinking: string): void =>
    frame(
      {
        type: 'assistant',
        uuid: `final-${at}`,
        message: {
          id: 'message-1',
          role: 'assistant',
          content: [{ type: 'thinking', thinking, signature: 'sig' }]
        }
      },
      at
    )
  const activity = () =>
    log.flatMap((entry) => (entry.kind === 'activity' ? [entry.activity] : [])).at(-1)
  const open = () => activity()?.reasoning ?? null
  const rows = () => log.flatMap((entry) => (entry.kind === 'row' ? [entry.body] : []))
  return { log, translator, frame, messageStart, blockStart, delta, stop, final, open, rows }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("Claude's open reasoning, as the host reports it live", () => {
  it('opens at the block start, before any text, and closes at its final frame', () => {
    const { messageStart, blockStart, delta, final, open, rows, translator } = setup()
    messageStart(1_000)
    blockStart(1_010)
    // Summaries trail the block start by seconds; the signal does not wait for them.
    expect(open()).toEqual({ session: true, subagents: [] })
    expect(rows()).toEqual([])
    delta(4_600, 'Weighing two approaches')
    final(8_000, 'Weighing two approaches')
    expect(open()).toBeNull()
    expect(rows().at(-1)).toMatchObject({ state: 'completed', completedAt: 8_000 })
    translator.dispose()
  })

  it('opens and closes a blank block, summaries off, and writes no row', () => {
    const { messageStart, blockStart, final, open, rows, translator } = setup()
    messageStart(1_000)
    blockStart(1_010)
    expect(open()?.session).toBe(true)
    final(5_000, '')
    expect(open()).toBeNull()
    expect(rows()).toEqual([])
    translator.dispose()
  })

  it('writes the closed row before it clears the signal', () => {
    const { log, messageStart, blockStart, delta, final, translator } = setup()
    messageStart(1_000)
    blockStart(1_010)
    delta(2_000, 'Weighing')
    final(3_000, 'Weighing')
    const closedRow = log.findIndex(
      (e) => e.kind === 'row' && e.body.kind === 'message' && e.body.state === 'completed'
    )
    const cleared = log.findLastIndex((e) => e.kind === 'activity' && e.activity === null)
    expect(closedRow).toBeGreaterThanOrEqual(0)
    expect(cleared).toBeGreaterThan(closedRow)
    translator.dispose()
  })

  it('closes at content_block_stop when no final frame comes, and the final keeps that end', () => {
    const { messageStart, blockStart, delta, stop, final, open, rows, translator } = setup()
    messageStart(1_000)
    blockStart(1_010)
    delta(2_000, 'Unfinished')
    stop(3_000)
    expect(open()).toBeNull()
    expect(rows().at(-1)).toMatchObject({ state: 'completed', completedAt: 3_000 })
    final(3_020, 'Unfinished thought')
    expect(rows().at(-1)).toMatchObject({
      blocks: [{ type: 'text', text: 'Unfinished thought' }],
      state: 'completed',
      completedAt: 3_000
    })
    expect(open()).toBeNull()
    translator.dispose()
  })

  it('closes when a new message starts in the same stream', () => {
    const { messageStart, blockStart, open, translator } = setup()
    messageStart(1_000)
    blockStart(1_010)
    messageStart(2_000, undefined, 'message-2')
    expect(open()).toBeNull()
    translator.dispose()
  })

  it('closes when the turn ends', () => {
    const { frame, messageStart, blockStart, open, translator } = setup()
    messageStart(1_000)
    blockStart(1_010)
    frame({ type: 'result', subtype: 'success', uuid: 'result', is_error: false }, 4_000)
    expect(open()).toBeNull()
    translator.dispose()
  })

  // Claude CLI 2.1.280 streams no subagent frames: a subagent's thinking arrives only finished, as an
  // assistant frame with parent_tool_use_id set (captured: c9/capture/run-bg-allow/stdout.jsonl:98,
  // 0 of 98 stream_events there carry a parent_tool_use_id).
  it.each([
    ['blank, as captured', ''],
    ['with summary text', 'Reading the diff']
  ])(
    "closes a subagent's finished thinking frame (%s) without opening any signal",
    (_, thinking) => {
      const { log, frame, messageStart, rows, translator } = setup()
      messageStart(1_000)
      frame(
        {
          type: 'assistant',
          uuid: 'b63dc3d2-fb90-43ad-a36a-a8cd4923cd25',
          parent_tool_use_id: 'toolu_0113cofGsD2kJXoxmbapdZbE',
          subagent_type: 'general-purpose',
          message: {
            model: 'claude-opus-5-5',
            id: 'msg_011CfMvBq8rZaPhJdxDXwLMU',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'thinking', thinking, signature: 'sig' }],
            stop_reason: null
          }
        },
        2_000
      )
      expect(log.some((e) => e.kind === 'activity' && e.activity?.reasoning !== undefined)).toBe(
        false
      )
      expect(rows()).toEqual(thinking ? [expect.objectContaining({ state: 'completed' })] : [])
      translator.dispose()
    }
  )
})
