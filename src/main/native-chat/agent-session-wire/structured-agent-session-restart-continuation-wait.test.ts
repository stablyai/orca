// The restart continuation is accepted like any send, so its verdict is its delivery: a cold start
// longer than the legacy client wait must not turn a continuation that went through into an
// "unconfirmed" one.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { structuredAgentSessionRestartResumeSurfaces } from './structured-agent-session-restart-resume-wiring'
import { StructuredAgentSessionSendSettlement } from './structured-agent-session-send-settlement'

const SESSION = 'session-1'
const MESSAGE = 'continuation-1'

let submission: AgentJournalSubmission
const journal = {
  submissions: (): AgentJournalSubmission[] => [submission],
  cursor: () => ({ epoch: 'epoch-1', sequence: 1 })
}

beforeEach(() => {
  vi.useFakeTimers()
  submission = {
    clientMessageId: MESSAGE,
    fence: 2,
    payloadFingerprint: 'fingerprint',
    dispatchState: 'pending',
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: null,
    handoverRecorded: true
  }
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the restart continuation waits for its delivery (W18)', () => {
  it('reaches accepted after a 40 s cold start, with nothing filed as unconfirmed', async () => {
    const settlement = new StructuredAgentSessionSendSettlement(() => journal)
    const surfaces = structuredAgentSessionRestartResumeSurfaces(
      {
        revealSession: async () => ({ readable: true }),
        hold: async () => undefined,
        release: () => undefined,
        send: async () => {
          throw new Error('not used')
        },
        waitForSendSettlement: settlement.wait
      },
      () => 0
    )

    const verdict = surfaces.awaitSendSettlement(SESSION, MESSAGE)
    await vi.advanceTimersByTimeAsync(40_000)
    submission = { ...submission, dispatchState: 'accepted', providerItemId: 'item-1' }
    settlement.publish(SESSION, journal)

    await expect(verdict).resolves.toMatchObject({
      value: { submission: { dispatchState: 'accepted' } }
    })
  })
})
