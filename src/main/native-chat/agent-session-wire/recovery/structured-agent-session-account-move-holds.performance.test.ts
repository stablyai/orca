// Perf contracts for #43145: a Dispatch end reaches only the chats held on it, so other ends cost
// no visits or wakes at 10 or 100 held chats; a hold's fallback check backs off while its work
// lasts. Each fails when its fix is reverted (a walk of every hold; a fixed two-minute check).
import { afterEach, expect, it, vi } from 'vitest'
import { AccountMoveHolds } from './structured-agent-session-account-move-holds'
import type { StructuredAgentSessionAccountTransition } from './structured-agent-session-outgrown-child'
import {
  disposeHeldOnDispatch,
  heldOnDispatch
} from './structured-agent-session-account-move-holds.test-fixture'

afterEach(disposeHeldOnDispatch)

it.each([10, 100])(
  'visits none of %i held chats for 10 or 100 other Dispatch ends, and wakes only the one whose Dispatch ended',
  async (held) => {
    const chats = heldOnDispatch(held)
    for (const events of [10, 100]) {
      for (let i = 0; i < events; i++) {
        chats.fire([`structured:elsewhere-${i}`])
        await new Promise((settled) => setImmediate(settled))
      }
      expect(chats.reads).toEqual({ sessions: 0, keys: 0 })
      expect(chats.wake).not.toHaveBeenCalled()
    }

    chats.fire(['structured:chat-3'])
    expect(chats.wake.mock.calls).toEqual([['chat-3']])
    chats.fire(['structured:chat-3'])
    expect(chats.wake.mock.calls).toEqual([['chat-3']])
  }
)

it('checks a hold on long-lived child work or a Dispatch 4 times in an hour, and one waiting on a turn never', () => {
  vi.useFakeTimers()
  try {
    const transitions: Record<string, StructuredAgentSessionAccountTransition> = {
      'child-work': { cause: 'account', waitsFor: 'child-work', from: null, to: null },
      dispatch: { cause: 'account', waitsFor: 'dispatch', from: null, to: null },
      turn: { cause: 'account', waitsFor: 'turn', from: null, to: null }
    }
    const sessions = new Map(Object.keys(transitions).map((id) => [id, { child: { fence: 1 } }]))
    const wakes = new Map<string, number>()
    const holds: AccountMoveHolds = new AccountMoveHolds({
      // Each check reads the chat again and finds the same work still owed.
      wake: (id) => {
        wakes.set(id, (wakes.get(id) ?? 0) + 1)
        holds.observe(sessions.get(id), id, transitions[id]!, 'sweep')
      },
      wakes: () => undefined,
      dispatchKey: (id) => `structured:${id}`,
      dispatchOpen: () => true,
      now: () => Date.now(),
      sessions
    })
    for (const [id, transition] of Object.entries(transitions)) {
      holds.observe(sessions.get(id), id, transition, 'sweep')
    }

    vi.advanceTimersByTime(60 * 60_000)

    // Two, then four, eight and sixteen minutes later; a fixed two-minute check would make 30.
    expect(Object.fromEntries(wakes)).toEqual({ 'child-work': 4, dispatch: 4 })
    holds.dispose()
  } finally {
    vi.useRealTimers()
  }
})
