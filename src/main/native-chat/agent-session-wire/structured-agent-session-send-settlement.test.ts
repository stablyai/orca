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

/** A message accepted and not yet handed over, while `activeTurnId` names the running turn. */
function queuedJournal(
  activeTurnId: string | null,
  handedOver = false
): Pick<AgentSessionJournal, 'submissions' | 'cursor' | 'activeTurnId'> {
  return {
    cursor: () => ({ epoch: 'epoch-1', sequence: handedOver ? 3 : 2 }),
    activeTurnId: () => activeTurnId,
    submissions: () => [
      {
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
      }
    ]
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

  it('leaves the plain handover wait to the handover', async () => {
    const settlements = new StructuredAgentSessionSendSettlement(() =>
      queuedJournal('compact:cmd-1')
    )
    const pending = settlements.wait('session-1', 'client-1', { until: 'handed-over', budgetMs: 1 })

    await expect(pending).resolves.toBeUndefined()
  })
})

describe("a wait for the message's own verdict", () => {
  /** A queued message waiting out a refused start, then rejected for good. */
  function waitingJournal(
    dispatchState: 'pending' | 'rejected'
  ): Pick<AgentSessionJournal, 'submissions' | 'cursor' | 'activeTurnId'> {
    return {
      cursor: () => ({ epoch: 'epoch-1', sequence: dispatchState === 'pending' ? 2 : 3 }),
      activeTurnId: () => null,
      submissions: () => [
        {
          clientMessageId: 'client-1',
          fence: 1,
          payloadFingerprint: 'fingerprint',
          dispatchState,
          providerItemId: null,
          reason: dispatchState === 'rejected' ? 'A Claude account switch is in progress.' : null,
          submittedAt: 1,
          resolvedAt: dispatchState === 'rejected' ? 3 : null,
          handoverRecorded: true,
          ...(dispatchState === 'pending'
            ? {
                startRetry: {
                  attempts: 1,
                  reason: 'A Claude account switch is in progress.',
                  rejection: { kind: 'accountSwitchInProgress' },
                  failedAt: 2,
                  nextAttemptAt: 15_002
                }
              }
            : {})
        }
      ]
    }
  }

  it('waits through the tries of a refused start, which end every other wait', async () => {
    const settlements = new StructuredAgentSessionSendSettlement(() => waitingJournal('pending'))
    await expect(settlements.wait('session-1', 'client-1')).resolves.toMatchObject({
      value: { submission: { dispatchState: 'pending' } }
    })
    let settled = false
    const verdict = settlements
      .wait('session-1', 'client-1', { until: 'verdict' })
      .then((result) => {
        settled = true
        return result
      })
    await Promise.resolve()
    expect(settled).toBe(false)

    settlements.publish('session-1', waitingJournal('rejected'))

    await expect(verdict).resolves.toMatchObject({
      value: { submission: { dispatchState: 'rejected' } }
    })
  })
})

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
