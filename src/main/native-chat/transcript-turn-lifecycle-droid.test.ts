import { describe, expect, it } from 'vitest'
import { nativeChatTurnLifecycleDecoderForAgent } from './transcript-turn-lifecycle'
import { decodeDroidTurnLifecycle } from './transcript-turn-lifecycle-droid'

const line = (record: unknown): string => JSON.stringify(record)

const userTurn = (text: string, extra: Record<string, unknown> = {}): string =>
  line({
    type: 'message',
    id: 'rec-9',
    timestamp: '2026-07-16T00:27:02.222Z',
    message: { role: 'user', content: [{ type: 'text', text }], ...extra }
  })

describe('decodeDroidTurnLifecycle', () => {
  it('is the registered decoder for droid', () => {
    expect(nativeChatTurnLifecycleDecoderForAgent('droid')).toBe(decodeDroidTurnLifecycle)
  })

  it('decodes turn outcomes', () => {
    expect(
      decodeDroidTurnLifecycle(
        line({ type: 'agent_turn_outcome', turnId: 'turn-1', reason: 'completed' }),
        'fallback'
      )
    ).toEqual({ state: 'completed', turnId: 'turn-1', timestamp: null })

    expect(
      decodeDroidTurnLifecycle(
        line({ type: 'agent_turn_outcome', turnId: 'turn-2', reason: 'cancelled' }),
        'fallback'
      )
    ).toEqual({ state: 'interrupted', turnId: 'turn-2', timestamp: null })
  })

  it('falls back to the offset id when an outcome omits its turn id', () => {
    expect(
      decodeDroidTurnLifecycle(
        line({ type: 'agent_turn_outcome', reason: 'completed' }),
        'fallback'
      )
    ).toEqual({ state: 'completed', turnId: 'fallback', timestamp: null })
  })

  it('ignores an unrecognized outcome reason rather than guessing a state', () => {
    expect(
      decodeDroidTurnLifecycle(
        line({ type: 'agent_turn_outcome', turnId: 't', reason: 'a-reason-from-the-future' }),
        'fallback'
      )
    ).toBeNull()
  })

  it('opens a generation on a user prompt, timestamped from the row', () => {
    expect(decodeDroidTurnLifecycle(userTurn('ship it'), 'fallback')).toEqual({
      state: 'working',
      turnId: 'rec-9',
      timestamp: Date.parse('2026-07-16T00:27:02.222Z')
    })
  })

  it('does not open a generation for tool results, injected context, or hook rows', () => {
    expect(
      decodeDroidTurnLifecycle(
        line({
          type: 'message',
          id: 'rec-1',
          message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] }
        }),
        'fallback'
      )
    ).toBeNull()
    expect(
      decodeDroidTurnLifecycle(userTurn('<system-reminder>context</system-reminder>'), 'f')
    ).toBeNull()
    expect(
      decodeDroidTurnLifecycle(
        userTurn('Hook execution: PreToolUse', {
          visibility: 'user_only',
          hookEventName: 'PreToolUse'
        }),
        'f'
      )
    ).toBeNull()
  })

  it('ignores assistant rows and unrelated records', () => {
    expect(decodeDroidTurnLifecycle('not json', 'f')).toBeNull()
    expect(decodeDroidTurnLifecycle(line({ type: 'todo_state' }), 'f')).toBeNull()
    expect(
      decodeDroidTurnLifecycle(
        line({
          type: 'message',
          id: 'rec-2',
          message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] }
        }),
        'f'
      )
    ).toBeNull()
  })
})
