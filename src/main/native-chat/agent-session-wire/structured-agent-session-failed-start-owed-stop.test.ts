// A child whose start failed is ended by a host stop before the next message starts afresh. When that
// stop cannot prove the child's exit, the child stays closing: the next message's start joins that
// close and is refused while it is still unproven. That message is rejected at once with why, for
// the person's Retry, never tried again on its own and never as Orca's fault.

import { describe, expect, it, vi } from 'vitest'
import { StructuredAgentSessionDeliveryLoop } from './structured-agent-session-delivery-loop'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'

const SESSION = 's1'
const CLOSING = {
  cause: 'host-stop',
  reason: null,
  recorded: Promise.resolve(null),
  requestedAt: { epoch: 'e1', sequence: 9 }
}

function rig(input: { closingBefore: boolean; acceptedSequence: number }) {
  const resolved: unknown[] = []
  const waitRows: unknown[] = []
  const submissions = [
    {
      clientMessageId: 'm2',
      dispatchState: 'pending',
      handoverRecorded: true,
      acceptedSequence: input.acceptedSequence,
      fence: 3
    }
  ]
  const journal = {
    submissions: () => submissions,
    resolveDispatch: async (row: { clientMessageId: string; state: string }) => {
      resolved.push(row)
      // As the journal folds it: the message is settled.
      for (const submission of submissions) {
        if (submission.clientMessageId === row.clientMessageId) {
          submission.dispatchState = row.state
        }
      }
    },
    rejectQueuedSubmissions: async () => {},
    wroteBeforeOpen: () => false,
    cursor: () => ({ epoch: 'e1', sequence: 10 }),
    snapshot: () => ({ items: [] }),
    appendItem: async (...row: unknown[]) => {
      waitRows.push(row)
    },
    itemBody: () => null,
    activeTurnId: () => null
  }
  const child: Record<string, unknown> = {
    generation: 'g1',
    fence: 3,
    phase: 'starting',
    startFailed: true,
    ...(input.closingBefore ? { close: CLOSING } : {})
  }
  const session: Record<string, unknown> = { journal, child }
  const endFailedStart = vi.fn(async () => {
    // As the host stop does when it cannot prove the exit: the child stays closing, and it throws.
    child.close = CLOSING
    throw new Error('stop could not prove the exit')
  })
  // The start joins that close first, which still cannot prove the exit.
  const ensureProviderChild = vi.fn(async () => ({
    ok: false as const,
    refusal: {
      code: 'agent_session_ownership_unknown',
      message: 'previous exit unverifiable',
      details: { reason: 'previousExitUnverifiable', ownerVerdict: 'unverifiable' }
    }
  }))
  const log = recordingStructuredAgentSessionLogger()
  const stopped = Promise.withResolvers<void>()
  const loop = new StructuredAgentSessionDeliveryLoop(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a loop rig carrying only the members this step reads; the session and journal stubs implement each one it calls.
    {
      sessions: new Map([[SESSION, session]]),
      adapter: {},
      serialize: async <T>(_sessionId: string, task: () => Promise<T>) => {
        const step = await task()
        if (step === 'stop') {
          setTimeout(stopped.resolve, 0)
        }
        return step
      },
      trackStart: <T>(start: Promise<T>) => start,
      ensureProviderChild,
      endFailedStart,
      conversationFence: () => 3,
      abandonQueued: async () => true,
      failureTextContext: () => ({}),
      logger: log.logger,
      record: () => null,
      readChildWork: () => undefined,
      flushStreamedEvents: async () => {},
      now: () => 1_000,
      setTimer: () => () => {}
    } as never
  )
  return { loop, resolved, waitRows, endFailedStart, ensureProviderChild, log, stopped }
}

describe('a failed start whose host stop cannot prove the exit', () => {
  it.each([
    ['the first time, with no close begun yet', false, 8, 1],
    ['a message accepted before the stop failed, with the child closing', true, 8, 0],
    ['a message accepted after the stop failed, with the child closing', true, 12, 0]
  ] as const)(
    '%s: the next message is rejected at once with why, never tried again on its own',
    async (_case, closingBefore, acceptedSequence, ends) => {
      const r = rig({ closingBefore, acceptedSequence })

      r.loop.wake(SESSION)
      await r.stopped.promise

      expect(r.resolved).toEqual([
        expect.objectContaining({
          clientMessageId: 'm2',
          state: 'rejected',
          rejection: expect.objectContaining({
            refusal: expect.objectContaining({
              details: expect.objectContaining({ reason: 'previousExitUnverifiable' })
            })
          })
        })
      ])
      expect(r.resolved[0]).not.toHaveProperty('startRetry')
      expect(r.waitRows).toEqual([])
      expect(r.endFailedStart).toHaveBeenCalledTimes(ends)
      expect(r.log.scopes()).not.toContain('delivery-loop')
    }
  )
})
