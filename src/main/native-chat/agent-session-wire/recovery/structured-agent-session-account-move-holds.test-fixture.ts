// Chats held on their own open Dispatch, shared by the account-move hold tests.
import { vi } from 'vitest'
import type { StructuredAgentSessionAccountMoveEdge } from '../host/structured-agent-session-host-types'
import { AccountMoveHolds } from './structured-agent-session-account-move-holds'

let holds: AccountMoveHolds | undefined

/** Ends the holds the last `heldOnDispatch` made; each test file calls it after each test. */
export function disposeHeldOnDispatch(): void {
  holds?.dispose()
  holds = undefined
}

/** `count` chats held on their own open Dispatch, and the edge listener their holds subscribed. */
export function heldOnDispatch(count: number, open = true) {
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
    dispatchOpen: () => open,
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
  return {
    wake,
    reads,
    fire: (ended: string[]) => edge!({ kind: 'dispatch', ended }),
    held: (id: string) => holds!.heldForPerson(sessions.get(id), id)
  }
}
