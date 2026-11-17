import { afterEach, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionAccountMoveEdge } from '../host/structured-agent-session-host-types'
import { AccountMoveHolds } from './structured-agent-session-account-move-holds'

let holds: AccountMoveHolds | undefined
afterEach(() => holds?.dispose())

/** `count` chats held on their own open Dispatch, and the edge listener their holds subscribed. */
function heldOnDispatch(count: number) {
  const sessions = new Map<string, { child: { fence: number } }>(
    Array.from({ length: count }, (_, index) => [`chat-${index}`, { child: { fence: 1 } }])
  )
  const reads = { sessions: 0, keys: 0 }
  const counted = {
    get: (id: string) => (reads.sessions++, sessions.get(id)),
    has: (id: string) => (reads.sessions++, sessions.has(id))
  }
  let edge: ((edge: StructuredAgentSessionAccountMoveEdge) => void) | undefined
  const wake = vi.fn<(sessionId: string) => void>()
  holds = new AccountMoveHolds({
    wake,
    wakes: () => ({
      subscribe: (listener) => {
        edge = listener
        return () => {}
      },
      selection: () => []
    }),
    dispatchKey: (sessionId) => (reads.keys++, `structured:${sessionId}`),
    now: () => 0,
    sessions: counted
  })
  for (const [id, session] of sessions) {
    holds.observe(
      session,
      id,
      { cause: 'account', waitsFor: 'dispatch', from: null, to: null },
      'person'
    )
  }
  wake.mockClear()
  reads.sessions = 0
  reads.keys = 0
  return { wake, reads, fire: (ended: string[]) => edge!({ kind: 'dispatch', ended }) }
}

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
