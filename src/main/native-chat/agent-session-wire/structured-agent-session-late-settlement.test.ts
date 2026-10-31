import { describe, expect, it, vi } from 'vitest'
import { DISPATCH_REJECTED_CANCELLED } from '../../../shared/structured-agent-session-dispatch-rejection'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import type { AgentSessionDispatchOutcome } from './structured-agent-session-adapter'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import {
  closeStructuredAgentSessionHandovers,
  finalizingStructuredAgentSessionInput,
  structuredAgentSessionHandingOver
} from './structured-agent-session-handing-over'

import {
  fixture,
  CALLER,
  handedOver,
  journal,
  sendParams,
  submissions
} from './structured-agent-session-late-settlement-contract-test-fixture'

describe('settling a send the provider proves it received after the ack window', () => {
  it('publishes acceptance during a pending send and never reopens it for retry', async () => {
    let finishDispatch!: (outcome: AgentSessionDispatchOutcome) => void
    fixture.dispatch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishDispatch = resolve
        })
    )
    const events: AgentSessionSubscribeEvent[] = []
    const unsubscribe = await fixture.host.subscribe({
      id: 'late-receipt',
      sessionId: SESSION,
      emit: (event) => events.push(event)
    })
    const params = sendParams('echo before send completes')
    const pending = fixture.host.send(CALLER, params)
    await vi.waitFor(async () => expect(fixture.dispatch).toHaveBeenCalledTimes(1))
    try {
      await fixture.host.settleLateDispatch({
        sessionId: SESSION,
        clientMessageId: params.envelope.clientOperationId,
        providerIdentity: { provider: 'claude', sessionId: THREAD, uuid: 'early-echo' }
      })
      const accepted = events.findLast(
        (event) =>
          event.type === 'batch' &&
          event.batch.submissions.some(
            (entry) => entry.clientMessageId === params.envelope.clientOperationId
          )
      )
      expect(accepted).toMatchObject({
        type: 'batch',
        batch: {
          submissions: [
            { clientMessageId: params.envelope.clientOperationId, dispatchState: 'accepted' }
          ]
        }
      })
    } finally {
      finishDispatch({ state: 'unknown', reason: 'ack timeout' })
      unsubscribe()
    }
    await expect(pending).resolves.toMatchObject({ ok: true })
    // Late uncertainty must not undo proven acceptance.
    await vi.waitFor(async () =>
      expect(await submissions()).toMatchObject([
        { clientMessageId: params.envelope.clientOperationId, dispatchState: 'accepted' }
      ])
    )
    await expect(
      fixture.host.send(CALLER, { ...params, retryUnknown: true })
    ).resolves.toMatchObject({
      ok: true,
      value: { submission: { dispatchState: 'accepted' } }
    })
    expect(fixture.dispatch).toHaveBeenCalledTimes(1)
  })

  it.each(['N-first', 'O-first'] as const)(
    'retains the original result owner with %s',
    async (order) => {
      const original = Promise.withResolvers<AgentSessionDispatchOutcome>()
      const nested = Promise.withResolvers<void>()
      const entered = Promise.withResolvers<void>()
      fixture.dispatch.mockImplementationOnce(() => original.promise)
      const held = journal()
      const acceptLate = held.acceptLate.bind(held)
      const acceptance = vi.spyOn(held, 'acceptLate').mockImplementation(async (input) => {
        entered.resolve()
        await nested.promise
        return acceptLate(input)
      })
      const params = sendParams('overlapping result and receipt')
      const id = params.envelope.clientOperationId
      const sending = fixture.host.send(CALLER, params)
      let settlement: Promise<void> | undefined
      let observed: Promise<void> | undefined
      let completed = 0
      try {
        await handedOver(id)
        settlement = fixture.host.settleLateDispatch({
          sessionId: SESSION,
          clientMessageId: id,
          providerIdentity: { provider: 'claude', sessionId: THREAD, uuid: 'overlap-echo' }
        })
        void settlement.catch(() => undefined)
        await entered.promise
        const completion = closeStructuredAgentSessionHandovers(held)
        expect(completion).toBeDefined()
        observed = completion?.then(() => {
          completed += 1
        })
        expect(finalizingStructuredAgentSessionInput(held, id)).toBe(true)
        expect(structuredAgentSessionHandingOver(held).has(id)).toBe(true)

        if (order === 'N-first') {
          nested.resolve()
          await settlement
          expect(finalizingStructuredAgentSessionInput(held, id)).toBe(true)
          expect(structuredAgentSessionHandingOver(held).has(id)).toBe(true)
          await new Promise<void>((resolve) => setImmediate(resolve))
          expect(completed).toBe(0)
          original.resolve({ state: 'unknown', reason: 'ack timeout' })
          await observed
        } else {
          original.resolve({ state: 'admitted' })
          await observed
          expect(finalizingStructuredAgentSessionInput(held, id)).toBe(false)
          expect(completed).toBe(1)
          expect(structuredAgentSessionHandingOver(held).has(id)).toBe(true)
          expect(closeStructuredAgentSessionHandovers(held)).toBeUndefined()
          nested.resolve()
          await settlement
        }

        await expect(sending).resolves.toMatchObject({ ok: true })
        await observed
        expect(completed).toBe(1)
        expect(finalizingStructuredAgentSessionInput(held, id)).toBe(false)
        expect(structuredAgentSessionHandingOver(held).has(id)).toBe(false)
        expect(held.submission(id)).toMatchObject({
          clientMessageId: id,
          dispatchState: 'accepted',
          providerItemId: `claude:${THREAD}:overlap-echo`
        })
        expect(fixture.dispatch).toHaveBeenCalledTimes(1)
        expect(acceptance).toHaveBeenCalledTimes(1)
      } finally {
        original.resolve({ state: 'unknown', reason: 'cleanup' })
        nested.resolve()
        await Promise.allSettled([sending, settlement, observed])
        acceptance.mockRestore()
      }
    }
  )

  it('persists an echo received while the provider is closing', async () => {
    fixture.dispatch.mockResolvedValueOnce({ state: 'unknown', reason: 'ack timeout' })
    const params = sendParams('received just before shutdown')
    await fixture.host.send(CALLER, params)
    await handedOver(params.envelope.clientOperationId)
    await vi.waitFor(async () =>
      expect(await submissions()).toMatchObject([{ dispatchState: 'unknown' }])
    )
    let settlement: Promise<void> | undefined
    fixture.closeSession.mockImplementationOnce(async () => {
      settlement = fixture.host.settleLateDispatch({
        sessionId: SESSION,
        clientMessageId: params.envelope.clientOperationId,
        providerIdentity: { provider: 'claude', sessionId: THREAD, uuid: 'closing-echo' }
      })
      void settlement.catch(() => undefined)
      return true
    })

    await fixture.host.close(SESSION, 'evict')
    await expect(settlement).resolves.toBeUndefined()
    await fixture.host.revealSession(SESSION)
    expect(await submissions()).toMatchObject([{ dispatchState: 'accepted' }])
    expect(fixture.dispatch).toHaveBeenCalledTimes(1)
  })

  it('moves a durable unknown to accepted so nothing offers to send it again', async () => {
    fixture.dispatch.mockRejectedValueOnce(new Error('socket closed'))
    const params = sendParams('sent while a turn was running')
    await fixture.host.send(CALLER, params)
    await handedOver(params.envelope.clientOperationId)
    await vi.waitFor(async () =>
      expect(await submissions()).toMatchObject([{ dispatchState: 'unknown' }])
    )

    await fixture.host.settleLateDispatch({
      sessionId: SESSION,
      clientMessageId: params.envelope.clientOperationId,
      providerIdentity: { provider: 'claude', sessionId: THREAD, uuid: 'late-uuid' }
    })

    expect(await submissions()).toMatchObject([
      { clientMessageId: params.envelope.clientOperationId, dispatchState: 'accepted' }
    ])
    // Retry previously redelivered; the settled send must remain single-dispatch.
    expect(fixture.dispatch).toHaveBeenCalledTimes(1)
  })

  it('settles a provider-cancelled queued send as rejected', async () => {
    fixture.dispatch.mockResolvedValueOnce({ state: 'admitted' })
    const params = sendParams('queued behind the active turn')
    await fixture.host.send(CALLER, params)
    await handedOver(params.envelope.clientOperationId)

    await fixture.host.settleLateDispatch({
      sessionId: SESSION,
      clientMessageId: params.envelope.clientOperationId,
      state: 'rejected',
      ...agentSessionFailureWords(agentSessionFailureFact('cancelled'), { surface: 'rejection' })
    })
    await fixture.host.settleLateDispatch({
      sessionId: SESSION,
      clientMessageId: params.envelope.clientOperationId,
      providerIdentity: { provider: 'claude', sessionId: THREAD, uuid: 'late-echo' }
    })

    expect(await submissions()).toMatchObject([
      {
        clientMessageId: params.envelope.clientOperationId,
        dispatchState: 'rejected',
        reason: DISPATCH_REJECTED_CANCELLED,
        rejection: { kind: 'cancelled' }
      }
    ])
  })
})
