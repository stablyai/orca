import type { createFixture } from './journal-unsent-send-hold-contract-test-fixture'
import { describe, expect, it } from 'vitest'
import { USER_MESSAGE_SOURCE } from '../../../../shared/agent-session/agent-session-message-source'
import { agentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session/failures/agent-session-failure-words'

export function registerJournalUnsentSendHoldRecoveryTests(
  fixture: ReturnType<typeof createFixture>
): void {
  describe('which sends an earlier host process left unsent are kept', () => {
    it('preserves the chat action on a card returned after failed startup', async () => {
      const journal = await fixture.open()
      const body = fixture.message('Please explain this code')
      await journal.appendSubmission({
        clientMessageId: 'failed-start',
        body,
        payloadFingerprint: fixture.fingerprint(body),
        fence: 0,
        origin: 'client',
        source: USER_MESSAGE_SOURCE,
        chatAction: 'message'
      })
      await journal.appendLifecycleBatch({
        settlementId: 'start-failure',
        fence: 0,
        keepFailedStart: true,
        mutations: [],
        dispatches: [
          {
            clientMessageId: 'failed-start',
            fence: 0,
            state: 'rejected',
            ...agentSessionFailureWords(agentSessionFailureFact('startFailed'), {
              surface: 'rejection'
            })
          }
        ]
      })
      expect(journal.queuedMessages.get('failed-start')).toMatchObject({
        state: 'returned',
        chatAction: 'message'
      })
    })

    it('leaves alone what this process accepted', async () => {
      const journal = await fixture.open()
      await fixture.accept(journal, 'mine', { origin: 'client', source: USER_MESSAGE_SOURCE })
      await fixture.hold(journal)
      expect(journal.submission('mine')?.dispatchState).toBe('pending')
      expect(journal.queuedMessages.list()).toEqual([])
    })
  })
}
