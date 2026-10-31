import type { createFixture } from './journal-unsent-send-hold-contract-test-fixture'
import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { USER_MESSAGE_SOURCE } from '../../../shared/agent-session/agent-session-message-source'

export function registerJournalUnsentSendHoldQueueTests(
  fixture: ReturnType<typeof createFixture>
): void {
  describe('where kept sends go in the queue', () => {
    it.each([
      { by: 'Send now', origin: 'client' as const, order: ['A', 'H', 'B', 'C'] },
      { by: 'the queue', origin: 'host' as const, order: ['A', 'B', 'H', 'C'] }
    ])(
      'in acceptance order, ahead of the cards already waiting, a hand-off by $by among them',
      async ({ origin, order }) => {
        const journal = await fixture.afterRestart(async (earlier) => {
          await earlier.queuedMessages.insert({
            messageId: 'H',
            body: fixture.message('H')
          })
          await earlier.queuedMessages.insert({
            messageId: 'C',
            body: fixture.message('C')
          })
          await fixture.accept(earlier, 'A', { origin: 'client', source: USER_MESSAGE_SOURCE })
          await earlier.appendSubmission(
            {
              clientMessageId: 'H-handoff',
              payloadFingerprint: fixture.fingerprint(fixture.message('H')),
              body: fixture.message('H'),
              fence: 0,
              handoverRecorded: true,
              origin
            },
            { messageId: 'H', expect: 'waiting' }
          )
          await fixture.accept(earlier, 'B', { origin: 'client', source: USER_MESSAGE_SOURCE })
        })
        await fixture.hold(journal)

        expect(fixture.cardOrder(journal)).toEqual(order)
      }
    )

    it('a run a crash cut short is placed again with the rest, in acceptance order', async () => {
      const interrupted = await fixture.afterRestart(async (earlier) => {
        await earlier.queuedMessages.insert({
          messageId: 'C',
          body: fixture.message('C')
        })
        await fixture.accept(earlier, 'A', { origin: 'client', source: USER_MESSAGE_SOURCE })
        await fixture.accept(earlier, 'B', { origin: 'client', source: USER_MESSAGE_SOURCE })
      })
      const resolve = interrupted.resolveDispatch.bind(interrupted)
      const fault = vi
        .spyOn(interrupted, 'resolveDispatch')
        .mockImplementation((...args) =>
          args[0].clientMessageId === 'B'
            ? Promise.reject(new Error('keep and fallback unavailable'))
            : resolve(...args)
        )
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        await expect(fixture.hold(interrupted)).rejects.toThrow('settling unsent sends failed')
        expect(interrupted.submission('A')).toMatchObject({
          dispatchState: 'rejected',
          keptAsQueuedMessageId: 'A'
        })
        expect(interrupted.submission('B')?.dispatchState).toBe('pending')
        expect(interrupted.queuedMessages.get('A')?.position).toBe(0)
        expect(interrupted.queuedMessages.get('C')?.position).toBe(2)
      } finally {
        fault.mockRestore()
        warn.mockRestore()
      }
      await interrupted.close()
      const journal = await fixture.open()
      await fixture.hold(journal)

      expect(fixture.cardOrder(journal)).toEqual(['A', 'B', 'C'])
    })
  })

  describe('a close of the chat', () => {
    it('keeps a person’s unsent send in place, rejected as closed, by the same rule as a restart', async () => {
      const journal = await fixture.open()
      await fixture.accept(journal, 'person', { origin: 'client', source: USER_MESSAGE_SOURCE })
      await fixture.accept(journal, 'mail', { origin: 'host', source: fixture.MAIL_SOURCE })
      await fixture.hold(journal, { cause: 'chatClosed' })

      expect(fixture.cardOrder(journal)).toEqual(['person'])
      expect(journal.queuedMessages.get('person')).toMatchObject({ holdReason: null })
      for (const id of ['person', 'mail']) {
        expect(journal.submission(id)).toMatchObject({
          dispatchState: 'rejected',
          ...fixture.CHAT_CLOSED
        })
      }
    })

    it('settles only what `which` names, leaving a later send queued', async () => {
      const journal = await fixture.open()
      await fixture.accept(journal, 'before', { origin: 'client', source: USER_MESSAGE_SOURCE })
      await fixture.accept(journal, 'after', { origin: 'client', source: USER_MESSAGE_SOURCE })
      await fixture.hold(journal, {
        cause: 'chatClosed',
        which: (submission) => submission.clientMessageId === 'before'
      })

      expect(fixture.cardOrder(journal)).toEqual(['before'])
      expect(journal.submission('after')?.dispatchState).toBe('pending')
    })
  })

  describe('the order kept cards stand in', () => {
    it('a card kept before the epoch rolled stays ahead of one kept after it', async () => {
      const journal = await fixture.afterRestart(async (earlier) => {
        for (const id of ['m1', 'm2', 'm3']) {
          await fixture.accept(earlier, id, { origin: 'host', source: fixture.MAIL_SOURCE })
        }
        await fixture.accept(earlier, 'A', { origin: 'client', source: USER_MESSAGE_SOURCE })
      })
      await fixture.hold(journal)
      await journal.rollEpoch('handle_forked', 0)
      await fixture.accept(journal, 'B', { origin: 'client', source: USER_MESSAGE_SOURCE })
      await journal.close()
      const reopened = await fixture.open()
      await fixture.hold(reopened)

      expect(reopened.queuedMessages.get('A')?.queuedAt?.epoch).not.toBe(
        reopened.queuedMessages.get('B')?.queuedAt?.epoch
      )
      expect(fixture.cardOrder(reopened)).toEqual(['A', 'B'])
    })
  })

  describe('the source a send records', () => {
    it('is folded from the row; a row without one folds without it', async () => {
      const journal = await fixture.open()
      await fixture.accept(journal, 'with-source', { origin: 'host', source: USER_MESSAGE_SOURCE })
      await fixture.accept(journal, 'without', { origin: 'client' })
      const folded: AgentJournalSubmission | undefined = journal.submission('with-source')
      expect(folded?.source).toEqual({ kind: 'user' })
      expect(journal.submission('without')).not.toHaveProperty('source')
    })

    it('keeps only the kind of an agent’s source, never its senders', async () => {
      const journal = await fixture.open()
      await fixture.accept(journal, 'mail', { origin: 'host', source: fixture.MAIL_SOURCE })
      await journal.close()
      const reopened = await fixture.open()
      expect(reopened.submission('mail')?.source).toEqual({ kind: 'agent' })
      expect(JSON.stringify(reopened.submission('mail'))).not.toContain('agent:coordinator')
    })
  })
}
