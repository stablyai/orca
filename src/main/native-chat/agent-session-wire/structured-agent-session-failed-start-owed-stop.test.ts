// A child whose start failed is ended by a host stop before the next message starts afresh. When that
// stop cannot prove the child's exit, the stop stays owed: the next message waits on it with the
// chat's one "still stopping" note, as after any such stop, and is never rejected as Orca's fault.

import { describe, expect, it, vi } from 'vitest'
import { StructuredAgentSessionDeliveryLoop } from './structured-agent-session-delivery-loop'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'

const SESSION = 's1'
const OWED = {
  generation: 'g1',
  fence: 3,
  cause: 'host-stop',
  requestedAt: { epoch: 'e1', sequence: 9 },
  failedAt: { epoch: 'e1', sequence: 9 }
}

function rig(input: { owedBefore: boolean; acceptedSequence: number }) {
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
    resolveDispatch: async (row: unknown) => {
      resolved.push(row)
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
  const session: Record<string, unknown> = {
    journal,
    child: { generation: 'g1', fence: 3, phase: 'starting', startFailed: true },
    ...(input.owedBefore ? { owesProviderChildWindDown: OWED } : {})
  }
  const endFailedStart = vi.fn(async () => {
    // As the host stop does when it cannot prove the exit: the stop stays owed, and it throws.
    session.owesProviderChildWindDown = OWED
    throw new Error('stop could not prove the exit')
  })
  // The start retries the owed stop first, which still cannot prove the exit.
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
    ['the first time, with nothing owed yet', false, 8, 1],
    ['a message accepted before the stop failed, with it owed', true, 8, 0],
    ['a message accepted after the stop failed, with it owed', true, 12, 0]
  ] as const)(
    '%s: the next message waits on the stop, never rejected',
    async (_case, owedBefore, acceptedSequence, ends) => {
      const r = rig({ owedBefore, acceptedSequence })

      r.loop.wake(SESSION)
      await r.stopped.promise

      expect(r.resolved).toEqual([])
      expect(r.waitRows).toHaveLength(1)
      expect(r.endFailedStart).toHaveBeenCalledTimes(ends)
      expect(r.log.scopes()).not.toContain('delivery-loop')
    }
  )
})
