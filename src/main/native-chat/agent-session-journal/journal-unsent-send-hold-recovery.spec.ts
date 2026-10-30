import type { createFixture } from './journal-unsent-send-hold-contract-test-fixture'
import { describe, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { USER_MESSAGE_SOURCE } from '../../../shared/agent-session/agent-session-message-source'
import { structuredAgentSessionCompactBody } from '../agent-session-wire/structured-agent-session-command-turn'
import { unsentSendKeptAsCard } from './journal-unsent-send-hold'

export function registerJournalUnsentSendHoldRecoveryTests(
  fixture: ReturnType<typeof createFixture>
): void {
  describe('which sends an earlier host process left unsent are kept', () => {
    it('keeps a person’s and a launch’s text, and an older build’s client send', async () => {
      const journal = await fixture.afterRestart(async (earlier) => {
        await fixture.accept(earlier, 'person', { origin: 'client', source: USER_MESSAGE_SOURCE })
        await fixture.accept(earlier, 'launch', { origin: 'host', source: USER_MESSAGE_SOURCE })
        await fixture.accept(earlier, 'legacy-client', { origin: 'client' })
      })
      await fixture.hold(journal)

      expect(fixture.cardOrder(journal)).toEqual(['person', 'launch', 'legacy-client'])
      await journal.close()
      const reopened = await fixture.open()
      for (const id of ['person', 'launch', 'legacy-client']) {
        expect(reopened.submission(id)).toMatchObject({
          dispatchState: 'rejected',
          ...fixture.HOST_RESTARTED,
          keptAsQueuedMessageId: id
        })
        expect(reopened.queuedMessages.get(id)).toMatchObject({
          state: 'waiting',
          holdReason: null,
          body: fixture.message(`text of ${id}`),
          fingerprint: fixture.fingerprint(fixture.message(`text of ${id}`)),
          queuedAt: { epoch: 'epoch-1', sequence: reopened.submission(id)?.acceptedSequence }
        })
      }
    })

    it('rejects mail, a dispatch preamble, a continuation, /compact, an image, and a send no one can attribute', async () => {
      const image: AgentJournalMessageItem = {
        kind: 'message',
        role: 'user',
        blocks: [
          { type: 'text', text: 'look' },
          { type: 'image-ref', path: '/tmp/attachment.png' }
        ]
      }
      const journal = await fixture.afterRestart(async (earlier) => {
        await fixture.accept(earlier, 'mail', { origin: 'host', source: fixture.MAIL_SOURCE })
        await fixture.accept(earlier, 'dispatch', { origin: 'host' })
        await fixture.accept(earlier, 'continuation', { origin: 'host' })
        await fixture.accept(earlier, 'compact', {
          origin: 'client',
          source: USER_MESSAGE_SOURCE,
          body: structuredAgentSessionCompactBody()
        })
        await fixture.accept(earlier, 'image', {
          origin: 'client',
          source: USER_MESSAGE_SOURCE,
          body: image
        })
        await fixture.accept(earlier, 'legacy-host', { origin: 'host' })
        await fixture.accept(earlier, 'no-origin')
      })
      await fixture.hold(journal)

      expect(journal.queuedMessages.list()).toEqual([])
      for (const id of [
        'mail',
        'dispatch',
        'continuation',
        'compact',
        'image',
        'legacy-host',
        'no-origin'
      ]) {
        expect(journal.submission(id)).toMatchObject({
          dispatchState: 'rejected',
          ...fixture.HOST_RESTARTED
        })
        expect(journal.submission(id)).not.toHaveProperty('keptAsQueuedMessageId')
      }
    })

    it.each([
      { by: 'Send now', origin: 'client' as const },
      { by: 'the queue', origin: 'host' as const }
    ])(
      'a card’s own hand-off by $by returns its card, and makes no second one',
      async ({ origin }) => {
        const journal = await fixture.afterRestart(async (earlier) => {
          await earlier.queuedMessages.insert({
            messageId: 'card',
            body: fixture.message('card text')
          })
          await earlier.appendSubmission(
            {
              clientMessageId: 'handoff',
              payloadFingerprint: fixture.fingerprint(fixture.message('card text')),
              body: fixture.message('card text'),
              fence: 0,
              handoverRecorded: true,
              origin
            },
            { messageId: 'card', expect: 'waiting' }
          )
        })
        await fixture.hold(journal)

        expect(journal.queuedMessages.list()).toHaveLength(1)
        expect(journal.queuedMessages.get('card')).toMatchObject({
          state: 'waiting',
          consumedAs: null,
          holdReason: null
        })
        expect(journal.queuedMessages.get('handoff')).toBeNull()
      }
    )

    it('leaves alone what this process accepted', async () => {
      const journal = await fixture.open()
      await fixture.accept(journal, 'mine', { origin: 'client', source: USER_MESSAGE_SOURCE })
      await fixture.hold(journal)
      expect(journal.submission('mine')?.dispatchState).toBe('pending')
      expect(journal.queuedMessages.list()).toEqual([])
    })

    it('never keeps a queue hand-off, a card’s link, or a send with no message body', () => {
      const body = fixture.message('x')
      expect(unsentSendKeptAsCard({ source: USER_MESSAGE_SOURCE }, body)).toBe(body)
      expect(unsentSendKeptAsCard({ origin: 'client', source: { kind: 'agent' } }, body)).toBeNull()
      expect(unsentSendKeptAsCard({ origin: 'client', source: { kind: '' } }, body)).toBeNull()
      expect(unsentSendKeptAsCard({ origin: 'client', source: { kind: 'orca' } }, body)).toBeNull()
      expect(unsentSendKeptAsCard({ origin: 'client', queuedMessageId: 'card' }, body)).toBeNull()
      expect(unsentSendKeptAsCard({ origin: 'client' }, null)).toBeNull()
    })

    it('never keeps a source kind this build does not know, whatever its origin', async () => {
      const journal = await fixture.afterRestart(async (earlier) => {
        await earlier.appendSubmission({
          clientMessageId: 'future',
          payloadFingerprint: fixture.fingerprint(fixture.message('from a newer build')),
          body: fixture.message('from a newer build'),
          fence: 0,
          handoverRecorded: true,
          origin: 'client',
          source: USER_MESSAGE_SOURCE
        })
        await fixture.storeSubmissionSourceAs(earlier, 'future', { kind: 'a-newer-kind' })
      })
      expect(journal.submission('future')?.source).toEqual({ kind: 'a-newer-kind' })
      await fixture.hold(journal)
      expect(journal.queuedMessages.list()).toEqual([])
      expect(journal.submission('future')).toMatchObject({ dispatchState: 'rejected' })
    })

    it('never keeps a send whose stored source has no readable kind', async () => {
      const journal = await fixture.afterRestart(async (earlier) => {
        await earlier.appendSubmission({
          clientMessageId: 'unreadable',
          payloadFingerprint: fixture.fingerprint(fixture.message('unreadable')),
          body: fixture.message('unreadable'),
          fence: 0,
          handoverRecorded: true,
          origin: 'client',
          source: USER_MESSAGE_SOURCE
        })
        await fixture.storeSubmissionSourceAs(earlier, 'unreadable', {})
      })
      expect(journal.submission('unreadable')?.source).toEqual({ kind: '' })
      await fixture.hold(journal)
      expect(journal.queuedMessages.list()).toEqual([])
      expect(journal.submission('unreadable')).toMatchObject({ dispatchState: 'rejected' })
    })
  })
}
