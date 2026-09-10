import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { StructuredAgentSessionSendSettlement } from './structured-agent-session-send-settlement'

function journal(dispatchState: 'pending' | 'accepted' | 'unknown'): AgentSessionJournal {
  return {
    cursor: () => ({ epoch: 'epoch-1', sequence: dispatchState === 'pending' ? 1 : 2 }),
    submissions: () => [
      {
        clientMessageId: 'client-1',
        fence: 1,
        payloadFingerprint: 'fingerprint',
        dispatchState,
        providerItemId: dispatchState === 'accepted' ? 'provider-1' : null,
        reason: dispatchState === 'unknown' ? 'provider exited' : null,
        submittedAt: 1,
        resolvedAt: dispatchState === 'pending' ? null : 2
      }
    ]
  } as AgentSessionJournal
}

function emptyJournal(): AgentSessionJournal {
  return {
    cursor: () => ({ epoch: 'epoch-1', sequence: 2 }),
    submissions: () => []
  } as unknown as AgentSessionJournal
}

describe('structured send settlement compatibility wait', () => {
  afterEach(() => vi.useRealTimers())

  it('returns a settlement already present in the journal', async () => {
    const settlements = new StructuredAgentSessionSendSettlement(() => journal('accepted'))

    await expect(settlements.wait('session-1', 'client-1')).resolves.toMatchObject({
      value: { submission: { dispatchState: 'accepted' } }
    })
  })

  it('rejects when the send is absent from the current session generation', async () => {
    const settlements = new StructuredAgentSessionSendSettlement(() => emptyJournal())

    await expect(settlements.wait('session-1', 'client-1')).rejects.toThrow(
      'agent session send disappeared before settlement'
    )
  })

  it('resolves from a journal publication after durable admission', async () => {
    const settlements = new StructuredAgentSessionSendSettlement(() => journal('pending'))
    const pending = settlements.wait('session-1', 'client-1')

    settlements.publish('session-1', journal('accepted'))

    await expect(pending).resolves.toMatchObject({
      cursor: { sequence: 2 },
      value: { submission: { dispatchState: 'accepted' } }
    })
  })

  it('removes an abandoned wait on transport cancellation', async () => {
    const settlements = new StructuredAgentSessionSendSettlement(() => journal('pending'))
    const controller = new AbortController()
    const pending = settlements.wait('session-1', 'client-1', controller.signal)

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

  it('caps compatibility observers retained for one session', async () => {
    const settlements = new StructuredAgentSessionSendSettlement(() => journal('pending'))
    const retained = Array.from({ length: 64 }, () =>
      settlements.wait('session-1', 'client-1').catch(() => undefined)
    )

    await expect(settlements.wait('session-1', 'client-1')).resolves.toBeUndefined()
    settlements.closeAll()
    await Promise.all(retained)
  })

  it('caps compatibility observers retained across sessions', async () => {
    const settlements = new StructuredAgentSessionSendSettlement(() => journal('pending'))
    const retained = Array.from({ length: 1_024 }, (_, index) =>
      settlements.wait(`session-${index}`, 'client-1').catch(() => undefined)
    )

    await expect(settlements.wait('session-overflow', 'client-1')).resolves.toBeUndefined()
    settlements.closeAll()
    await Promise.all(retained)
  })

  it('ends only the compatibility observation when the session closes', async () => {
    const settlements = new StructuredAgentSessionSendSettlement(() => journal('pending'))
    const pending = settlements.wait('session-1', 'client-1')

    settlements.closeSession('session-1')

    await expect(pending).resolves.toBeUndefined()
    settlements.publish('session-1', journal('accepted'))
  })

  it('rejects a wait when an authoritative publication drops the submission', async () => {
    const settlements = new StructuredAgentSessionSendSettlement(() => journal('pending'))
    const pending = settlements.wait('session-1', 'client-1')

    settlements.publish('session-1', emptyJournal())

    await expect(pending).rejects.toThrow('agent session send disappeared before settlement')
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
