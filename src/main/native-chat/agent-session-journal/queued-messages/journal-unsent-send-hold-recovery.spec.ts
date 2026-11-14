import type { createFixture } from './journal-unsent-send-hold-contract-test-fixture'
import { describe, expect, it } from 'vitest'
import { USER_MESSAGE_SOURCE } from '../../../../shared/agent-session/agent-session-message-source'

export function registerJournalUnsentSendHoldRecoveryTests(
  fixture: ReturnType<typeof createFixture>
): void {
  describe('which sends an earlier host process left unsent are kept', () => {
    it('leaves alone what this process accepted', async () => {
      const journal = await fixture.open()
      await fixture.accept(journal, 'mine', { origin: 'client', source: USER_MESSAGE_SOURCE })
      await fixture.hold(journal)
      expect((await journal.reads.submission('mine'))?.dispatchState).toBe('pending')
      expect(await journal.queuedMessages.list()).toEqual([])
    })
  })
}
