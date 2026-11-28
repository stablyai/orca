import { expect, it, vi } from 'vitest'
import { emitClaudeStructuredSessionEvent } from './claude-structured-event-delivery'
import { waitForReplay } from '../dispatch/claude-structured-dispatch-waiters'
import type { ClaudeSession } from '../claude-structured-session-state'

const FOLLOW_UP = 'ec94ea32-e87c-4cef-9ff1-be319d2e77a5'

it('settles a follow-up cancelled by the automatic dead-login Stop as not run', async () => {
  const interrupt = vi.fn(async () => ({ cancelled: [FOLLOW_UP] }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the auth-retry Stop reads only these fields.
  const session = {
    capabilities: ['interrupt_cancel_queued_v1'],
    connection: { interrupt },
    translator: { currentTurnId: 'turn-a', handle: () => {} },
    childWork: { observe: () => {} },
    backgroundTasks: { observe: () => {} },
    commands: { observe: () => false },
    dispatchSequence: 0,
    dispatchWaiters: [],
    retiredDispatchWaiters: []
  } as unknown as ClaudeSession
  const { promise } = waitForReplay(session, false, FOLLOW_UP, 'key', 'client-b', null)
  const onDispatchSettledLate = vi.fn()

  emitClaudeStructuredSessionEvent({
    session,
    event: {
      type: 'message',
      sessionId: 'orca-1',
      observedAt: 1_000,
      message: {
        type: 'system',
        subtype: 'api_retry',
        attempt: 3,
        error_status: 401,
        parent_tool_use_id: null
      }
    },
    deps: { onDispatchSettledLate },
    publishChildWork: () => {}
  })

  expect(await promise).toBeNull()
  expect(interrupt).toHaveBeenCalledWith(expect.objectContaining({ cancelQueued: true }))
  expect(onDispatchSettledLate).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: 'orca-1',
      clientMessageId: 'client-b',
      state: 'rejected',
      unrun: true
    })
  )
  expect(session.dispatchWaiters).toHaveLength(0)
})
