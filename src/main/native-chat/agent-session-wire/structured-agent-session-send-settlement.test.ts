import { describe, expect, it } from 'vitest'
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

  it('rejects retained waits when their session closes', async () => {
    const settlements = new StructuredAgentSessionSendSettlement(() => journal('pending'))
    const pending = settlements.wait('session-1', 'client-1')

    settlements.closeSession('session-1')

    await expect(pending).rejects.toThrow('agent session closed before send settlement')
    settlements.publish('session-1', journal('accepted'))
  })

  it('rejects a wait when an authoritative publication drops the submission', async () => {
    const settlements = new StructuredAgentSessionSendSettlement(() => journal('pending'))
    const pending = settlements.wait('session-1', 'client-1')

    settlements.publish('session-1', emptyJournal())

    await expect(pending).rejects.toThrow('agent session send disappeared before settlement')
  })

  it('rejects every retained wait when the host closes', async () => {
    const settlements = new StructuredAgentSessionSendSettlement(() => journal('pending'))
    const first = settlements.wait('session-1', 'client-1')
    const second = settlements.wait('session-2', 'client-1')

    settlements.closeAll()

    await expect(first).rejects.toThrow('agent session closed before send settlement')
    await expect(second).rejects.toThrow('agent session closed before send settlement')
  })
})
