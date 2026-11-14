import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  StructuredAgentSessionSendSettlement,
  type SendSettlementJournal
} from '../structured-agent-session-send-settlement'

function journal(dispatchState: 'pending' | 'accepted' | 'unknown'): SendSettlementJournal {
  return {
    activeTurnId: () => null,
    cursor: async () => ({ epoch: 'epoch-1', sequence: dispatchState === 'pending' ? 1 : 2 }),
    submission: async () => ({
      clientMessageId: 'client-1',
      fence: 1,
      payloadFingerprint: 'fingerprint',
      dispatchState,
      providerItemId: dispatchState === 'accepted' ? 'provider-1' : null,
      reason: dispatchState === 'unknown' ? 'provider exited' : null,
      submittedAt: 1,
      resolvedAt: dispatchState === 'pending' ? null : 2
    })
  }
}

function queuedJournal(activeTurnId: string | null, handedOver = false): SendSettlementJournal {
  return {
    cursor: async () => ({ epoch: 'epoch-1', sequence: handedOver ? 3 : 2 }),
    activeTurnId: () => activeTurnId,
    submission: async () => ({
      clientMessageId: 'client-1',
      fence: 1,
      payloadFingerprint: 'fingerprint',
      dispatchState: 'pending',
      providerItemId: null,
      reason: null,
      submittedAt: 1,
      resolvedAt: null,
      handoverRecorded: true,
      ...(handedOver ? { handedOverAt: 3 } : {})
    })
  }
}

describe('a wait that also ends behind a running command', () => {
  const until = 'handed-over-or-behind-command' as const

  it('ends once the message waits behind a running command', async () => {
    const settlements = new StructuredAgentSessionSendSettlement(() => queuedJournal('turn-1'))
    const pending = settlements.wait('session-1', 'client-1', { until })

    settlements.publish('session-1', queuedJournal('compact:cmd-1'))

    const settled = await pending
    if (!settled || !('submission' in settled.value)) {
      throw new Error('expected the submission arm')
    }
    expect(settled.value.submission.dispatchState).toBe('pending')
    expect(settled.value.submission).not.toHaveProperty('handedOverAt')
  })

  it('keeps waiting for the handover behind anything that is not a command', async () => {
    const settlements = new StructuredAgentSessionSendSettlement(() => queuedJournal(null))
    let settled = false
    const pending = settlements.wait('session-1', 'client-1', { until }).then((result) => {
      settled = true
      return result
    })

    settlements.publish('session-1', queuedJournal('turn-1'))
    await Promise.resolve()
    expect(settled).toBe(false)
    settlements.publish('session-1', queuedJournal('turn-1', true))

    await expect(pending).resolves.toMatchObject({ value: { submission: { handedOverAt: 3 } } })
  })
})

describe('structured send settlement compatibility wait', () => {
  afterEach(() => vi.useRealTimers())

  it('removes an abandoned wait on transport cancellation', async () => {
    const settlements = new StructuredAgentSessionSendSettlement(() => journal('pending'))
    const controller = new AbortController()
    const pending = settlements.wait('session-1', 'client-1', { signal: controller.signal })

    controller.abort(new Error('transport closed'))
    await expect(pending).rejects.toThrow('transport closed')
    settlements.publish('session-1', journal('accepted'))
  })

  it('expires only the compatibility observer when the client leaves its socket open', async () => {
    vi.useFakeTimers()
    const settlements = new StructuredAgentSessionSendSettlement(() => journal('pending'))
    const pending = settlements.wait('session-1', 'client-1')

    await vi.advanceTimersByTimeAsync(30_000)

    await expect(pending).resolves.toBeUndefined()
    settlements.publish('session-1', journal('accepted'))
  })

  it('ends only the compatibility observation when the session closes', async () => {
    const settlements = new StructuredAgentSessionSendSettlement(() => journal('pending'))
    const pending = settlements.wait('session-1', 'client-1')

    settlements.closeSession('session-1')

    await expect(pending).resolves.toBeUndefined()
    settlements.publish('session-1', journal('accepted'))
  })

  it('ends every compatibility observation when the host closes', async () => {
    const settlements = new StructuredAgentSessionSendSettlement(() => journal('pending'))
    const first = settlements.wait('session-1', 'client-1')
    const second = settlements.wait('session-2', 'client-1')

    settlements.closeAll()

    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toBeUndefined()
  })
})

it('a row wait follows a replacement handoff and resolves withdrawal or returned recovery', async () => {
  let row: ReturnType<NonNullable<SendSettlementJournal['queuedSend']>> = {
    clientMessageId: 'row',
    queued: { messageId: 'row', position: 1, state: 'waiting' }
  }
  const state: SendSettlementJournal = {
    ...journal('pending'),
    queuedSend: () => row,
    submission: async () => undefined
  }
  const settlements = new StructuredAgentSessionSendSettlement(() => state)
  const pending = settlements.wait('session-1', 'row')
  const attempt = (await journal('pending').submission('client-1'))!
  row = { clientMessageId: 'row', submission: { ...attempt, clientMessageId: 'attempt-1' } }
  settlements.publish('session-1', state)
  row = { clientMessageId: 'row', queued: { messageId: 'row', position: 1, state: 'waiting' } }
  settlements.publish('session-1', state)
  row = {
    clientMessageId: 'row',
    submission: {
      ...attempt,
      clientMessageId: 'attempt-2',
      dispatchState: 'accepted'
    }
  }
  settlements.publish('session-1', state)
  await expect(pending).resolves.toMatchObject({
    value: {
      submission: {
        clientMessageId: 'attempt-2',
        dispatchState: 'accepted'
      }
    }
  })
  for (const result of ['withdrawn', 'returned'] as const) {
    row = { clientMessageId: 'row', queued: { messageId: 'row', position: 1, state: result } }
    await expect(settlements.wait('session-1', 'row')).resolves.toMatchObject({
      value: { queued: { state: result } }
    })
  }
})
