// Perf contract for #43145: a Dispatch end reaches only the chats held on it, so other ends cost
// no visits or wakes at 10 or 100 held chats. Fails when the keyed index is reverted to a walk.
import { afterEach, expect, it } from 'vitest'
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
