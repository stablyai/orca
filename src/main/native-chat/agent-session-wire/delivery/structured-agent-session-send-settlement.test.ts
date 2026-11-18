import { expect, it } from 'vitest'
import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  StructuredAgentSessionSendSettlement,
  type SendSettlementJournal
} from './structured-agent-session-send-settlement'

it('waits past an ended attempt until the provider answers when asked for dispatch', async () => {
  let dispatchState: AgentJournalSubmission['dispatchState'] = 'pending'
  const journal: SendSettlementJournal = {
    submission: async () => ({
      clientMessageId: 'send-1',
      fence: 1,
      payloadFingerprint: 'fingerprint',
      dispatchState,
      providerItemId: null,
      reason: null,
      submittedAt: 1,
      resolvedAt: null
    }),
    cursor: async () => ({ epoch: 'e', sequence: 1 }),
    attemptEnded: () => true,
    activeTurnId: () => null
  }
  const settlement = new StructuredAgentSessionSendSettlement(() => journal)

  const answered = await settlement.wait('session-1', 'send-1', { until: 'answered' })
  let held = true
  const dispatched = settlement.wait('session-1', 'send-1', { until: 'dispatched' })
  void dispatched.then(() => (held = false))
  await new Promise((resolve) => setImmediate(resolve))
  expect(held).toBe(true)
  dispatchState = 'accepted'
  settlement.publish('session-1', journal)

  expect(answered?.value).toMatchObject({ submission: { dispatchState: 'unknown' } })
  expect((await dispatched)?.value).toMatchObject({ submission: { dispatchState: 'accepted' } })
})
