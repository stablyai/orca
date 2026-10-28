import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { structuredAgentSessionEndedChildFailure } from './structured-agent-session-ended-child-failure'
import {
  acceptedDispatch,
  createRestTestRig,
  foundRestTestChat,
  REST_TEST_CALLER as CALLER,
  REST_TEST_SESSION as SESSION,
  restTestSend,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'
import * as handover from './structured-agent-session-handover'
import type { StructuredAgentSessionStartFlight } from './structured-agent-session-start-flight'
import type {
  StructuredAgentSessionChildEndCause,
  StructuredAgentSessionEndedChild
} from './structured-agent-session-host-types'

const EXIT_FAILURE = agentSessionFailureFact('providerExited', {
  detail: { text: 'crashed', audience: 'log' }
})

function ended(
  cause: StructuredAgentSessionChildEndCause,
  duringStartup: boolean
): StructuredAgentSessionEndedChild {
  return {
    generation: 'generation-1',
    fence: 2,
    rootGone: true,
    cause,
    reason: null,
    failure: EXIT_FAILURE,
    duringStartup,
    endedAt: { epoch: 'epoch-1', sequence: 3 }
  }
}

describe('what a child end means for the messages queued behind it', () => {
  it.each([false, true])("fails nothing after a user's Stop (during startup: %s)", (starting) => {
    expect(structuredAgentSessionEndedChildFailure(ended('user-stop', starting))).toBeNull()
  })

  it.each([false, true])(
    'keeps a recorded failure after a host stop (during startup: %s)',
    (starting) => {
      expect(structuredAgentSessionEndedChildFailure(ended('host-stop', starting))).toEqual({
        failure: EXIT_FAILURE
      })
      expect(
        structuredAgentSessionEndedChildFailure({
          ...ended('host-stop', starting),
          failure: undefined
        })
      ).toEqual({
        failure: { kind: 'hostStopped' }
      })
    }
  )

  it.each(['exit', 'attach-failed', 'evict'] as const)(
    'carries the recorded failure of a %s, as a failed start while starting',
    (cause) => {
      expect(structuredAgentSessionEndedChildFailure(ended(cause, true))).toEqual({
        exit: EXIT_FAILURE
      })
      expect(structuredAgentSessionEndedChildFailure(ended(cause, false))).toEqual({
        failure: EXIT_FAILURE
      })
      expect(
        structuredAgentSessionEndedChildFailure({ ...ended(cause, false), failure: undefined })
      ).toEqual({ failure: agentSessionFailureFact('providerExited') })
    }
  )
})

describe('delivery iteration settlement and ownership', () => {
  let rig: RestTestRig
  const loop = () => rig.host.collaboratorsForTests().conversationDelivery.loop
  const journal = () => rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const fence = () => rig.store.getRecord(SESSION)!.lease.runtimeFence
  const parked = () => vi.waitFor(() => expect(loop().isRunning(SESSION)).toBe(false))
  const timer = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
  beforeEach(async () => {
    rig = await createRestTestRig()
    await foundRestTestChat(rig)
    await parked()
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    loop().dispose()
    await rig.dispose()
  })
  function noWrite() {
    // Old rollback-shaped boundary: no provider admission and no journal commit.
    // Bound a broken loop before it can starve timers on this shared machine.
    let attempts = 0
    return vi.spyOn(handover, 'beginSubmissionHandover').mockImplementation(async () => {
      if (attempts++ > 8) {
        throw new Error('iteration bound')
      }
      return { run: async (commit) => commit(async () => {}) }
    })
  }
  async function pending() {
    expect(await rig.host.send(CALLER, restTestSend('still owed', fence()))).toMatchObject({
      ok: true
    })
    await parked()
    return journal().submissions().at(-1)!
  }

  it('parks a no-op dispatch/resolver, preserves unwritten input, then delivers once on a legitimate wake', async () => {
    const blocked = noWrite()
    const row = await pending()
    expect(blocked.mock.calls.length).toBeLessThanOrEqual(2)
    expect(row).toMatchObject({ dispatchState: 'pending', handoverRecorded: true })
    expect(row.handedOverAt).toBeUndefined()
    await timer()
    expect(rig.adapter.dispatch).toHaveBeenCalledTimes(1)
    blocked.mockRestore()
    const current = rig.host.collaboratorsForTests().sessions.get(SESSION)!
    current.child!.phase = 'starting'
    const ready = Promise.withResolvers<'ready'>()
    const readiness = vi
      .spyOn(loop()['deps'], 'readiness')
      .mockReturnValue({ wait: () => ready.promise })
    const draining = loop().wake(SESSION)
    await vi.waitFor(() => expect(readiness).toHaveBeenCalledTimes(1))
    const replacement = { ...current.child!, generation: 'replacement', phase: 'ready' as const }
    current.child = replacement
    current.lastEndedChild = ended('user-stop', true)
    rig.adapter.dispatch.mockImplementationOnce(async () => {
      expect(current.child).toBe(replacement)
      return acceptedDispatch()
    })
    ready.resolve('ready')
    await draining
    expect(journal().submissions().at(-1)?.dispatchState).toBe('accepted')
    expect(rig.adapter.dispatch).toHaveBeenCalledTimes(2)
    await loop().wake(SESSION)
    expect(rig.adapter.dispatch).toHaveBeenCalledTimes(2)
  })

  it.each(['unchanged', 'completed', 'replacement', 'immediate'] as const)(
    'consumes only completion of the flight actually joined (%s)',
    async (schedule) => {
      const blocked = noWrite()
      const flights = rig.host.collaboratorsForTests().runtimeState.startFlights
      const done = Promise.withResolvers<{ ok: true }>()
      const flight: StructuredAgentSessionStartFlight = {
        attemptId: 'F',
        outcome: done.promise,
        abort() {}
      }
      flights.register(SESSION, flight)
      const start = vi.spyOn(loop()['deps'], 'startProviderChild')
      if (schedule === 'immediate') {
        start.mockImplementation(() => ({ outcome: Promise.resolve({ ok: true }) }))
      }
      expect(await rig.host.send(CALLER, restTestSend('join F', fence()))).toMatchObject({
        ok: true
      })
      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1))
      if (schedule === 'completed') {
        flights.end(SESSION, 'F')
      }
      const next = Promise.withResolvers<{ ok: true }>()
      if (schedule === 'replacement') {
        flights.register(SESSION, { ...flight, attemptId: 'G', outcome: next.promise })
      }
      done.resolve({ ok: true })
      if (schedule === 'replacement') {
        await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2))
        expect(loop().isRunning(SESSION)).toBe(true)
        next.resolve({ ok: true })
      }
      await parked()
      await timer()
      expect(start).toHaveBeenCalledTimes(schedule === 'replacement' ? 2 : 1)
      expect(blocked).toHaveBeenCalledTimes(schedule === 'completed' ? 1 : 0)
      expect(journal().submissions().at(-1)?.handedOverAt).toBeUndefined()
    }
  )

  it('covers dispatch journal settlement, resolver, release and a wake during final settlement together', async () => {
    const held = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const boundary = vi
      .spyOn(handover, 'beginSubmissionHandover')
      .mockImplementation(async (ctx) => ({
        run: async (commit) => {
          try {
            // Dispatch itself writes, before the serialized resolver exists.
            await ctx.journal.appendItem(
              { provider: 'codex', threadId: 'thread', turnId: 'settled', ordinal: 0 },
              { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'settled' }] },
              { fence: ctx.fence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
            )
            entered.resolve()
            await held.promise
            await commit(async () => {
              void loop().wake(SESSION)
            })
          } finally {
            boundary.mockImplementation(async () => {
              if (boundary.mock.calls.length > 8) {
                throw new Error('iteration bound')
              }
              return { run: async (commit) => commit(async () => {}) }
            })
          }
        }
      }))
    const sending = rig.host.send(CALLER, restTestSend('settlement wake', fence()))
    await entered.promise
    expect(await sending).toMatchObject({ ok: true })
    held.resolve()
    await parked()
    expect(boundary).toHaveBeenCalledTimes(2)
    expect(journal().submissions().at(-1)?.handedOverAt).toBeUndefined()
    // A wake at serialized parking creates a successor before the old finalizer runs.
    const deps = loop()['deps']
    const park = deps.deliveryOrder.parkSends.bind(deps.deliveryOrder)
    const successorHeld = Promise.withResolvers<void>()
    const successorEntered = Promise.withResolvers<void>()
    let successor: Promise<void> | undefined
    vi.spyOn(deps.deliveryOrder, 'parkSends').mockImplementationOnce((id) => {
      park(id)
      boundary.mockImplementationOnce(async () => ({
        run: async (commit) => {
          successorEntered.resolve()
          await successorHeld.promise
          await commit(async () => {})
        }
      }))
      successor = loop().wake(id)
    })
    await loop().wake(SESSION)
    await successorEntered.promise
    expect(loop().isRunning(SESSION)).toBe(true)
    loop().dispose()
    expect(loop()['running'].size).toBe(0)
    successorHeld.resolve()
    await successor
    expect(loop()['runs'].size).toBe(0)
    expect(journal().submissions().at(-1)?.handedOverAt).toBeUndefined()
    await loop().wake(SESSION)
    expect(loop().isRunning(SESSION)).toBe(false)
  })

  it('reclaims N and 10N parked runs with linear boundary fact reads', async () => {
    const sessions = rig.host.collaboratorsForTests().sessions
    const cursor = vi.spyOn(journal(), 'cursor')
    for (const n of [10, 100]) {
      cursor.mockClear()
      for (let i = 0; i < n; i++) {
        const id = `scale-${i}`
        sessions.set(id, { ...sessions.get(SESSION)! })
        await loop().wake(id)
        sessions.delete(id)
      }
      expect(cursor).toHaveBeenCalledTimes(2 * n)
      expect(loop()['running'].size).toBe(0)
      expect(loop()['runs'].size).toBe(0)
    }
  })
})
