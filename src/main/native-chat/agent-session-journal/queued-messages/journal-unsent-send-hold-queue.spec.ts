import { openTestAgentSessionDatabase } from '../../../runtime/agent-session/records/agent-session-record-store-test-harness'
import { openAgentSessionJournal } from '../journal-store-factory'
import { structuredSendAnswer } from '../../agent-session-wire/delivery/structured-agent-session-queued-send-answer'
import type { createFixture } from './journal-unsent-send-hold-contract-test-fixture'
import { describe, expect, it } from 'vitest'

import { USER_MESSAGE_SOURCE } from '../../../../shared/agent-session/agent-session-message-source'

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

        expect(await fixture.cardOrder(journal)).toEqual(order)
      }
    )
  })

  describe('a close of the chat', () => {
    it('keeps a person’s unsent send in place, rejected as closed, by the same rule as a restart', async () => {
      const journal = await fixture.open()
      await fixture.accept(journal, 'person', { origin: 'client', source: USER_MESSAGE_SOURCE })
      await fixture.accept(journal, 'mail', { origin: 'host', source: fixture.MAIL_SOURCE })
      await fixture.hold(journal, { cause: 'chatClosed' })

      expect(await fixture.cardOrder(journal)).toEqual(['person'])
      expect(await journal.queuedMessages.get('person')).toMatchObject({ holdReason: null })
      for (const id of ['person', 'mail']) {
        expect(await journal.reads.submission(id)).toMatchObject({
          dispatchState: 'rejected',
          ...fixture.CHAT_CLOSED
        })
      }
    })

    it('settles only the selected send, leaving a later send queued', async () => {
      const journal = await fixture.open()
      await fixture.accept(journal, 'before', { origin: 'client', source: USER_MESSAGE_SOURCE })
      await fixture.accept(journal, 'after', { origin: 'client', source: USER_MESSAGE_SOURCE })
      await fixture.hold(journal, {
        cause: 'chatClosed',
        select: { only: { clientMessageId: 'before', fence: 0 } }
      })

      expect(await fixture.cardOrder(journal)).toEqual(['before'])
      expect((await journal.reads.submission('after'))?.dispatchState).toBe('pending')
    })
  })

  describe('old saved queues', () => {
    it.each(['stopped', 'reserved-command', 'moved-command'] as const)(
      'preserves the %s ordering boundary',
      async (shape) => {
        const journal = await fixture.afterRestart(async (earlier) => {
          if (shape === 'stopped') {
            await earlier.queuedMessages.insert({ messageId: 'W', body: fixture.message('W') })
            await earlier.appendStopEvent({ reason: 'user-stop' }, 0)
            await fixture.accept(earlier, 'S', { origin: 'client', source: USER_MESSAGE_SOURCE })
            return
          }
          await earlier.queuedMessages.insert({
            messageId: 'C1',
            body: { ...fixture.message('/compact'), command: { name: 'compact' as const } }
          })
          await fixture.accept(earlier, 'S', { origin: 'client', source: USER_MESSAGE_SOURCE })
          await earlier.queuedMessages.insert({ messageId: 'C2', body: fixture.message('C2') })
          await earlier.queuedMessages.move({ messageId: 'C2', beforeMessageId: 'C1' })
          if (shape === 'reserved-command') {
            await earlier.appendSubmission(
              {
                clientMessageId: 'command-attempt',
                origin: 'client',
                body: { ...fixture.message('/compact'), command: { name: 'compact' as const } },
                payloadFingerprint: fixture.fingerprint({
                  ...fixture.message('/compact'),
                  command: { name: 'compact' as const }
                }),
                handoverRecorded: true,
                fence: 0
              },
              { messageId: 'C1', expect: 'waiting' }
            )
            await earlier.resolveDispatch({
              clientMessageId: 'command-attempt',
              state: 'pending',
              turnScope: { kind: 'thread' },
              fence: 0
            })
          }
        })
        expect(await fixture.cardOrder(journal)).toEqual(
          shape === 'stopped'
            ? ['S', 'W']
            : shape === 'reserved-command'
              ? ['C2', 'S']
              : ['C2', 'C1', 'S']
        )
      }
    )
    it('keeps unsent mail in custody as waiting across restart', async () => {
      const journal = await fixture.afterRestart(async (earlier) => {
        await fixture.accept(earlier, 'mail', {
          origin: 'host',
          source: { kind: 'agent' },
          body: { ...fixture.message('mail'), from: fixture.MAIL_SOURCE }
        })
      })
      await expect(
        structuredSendAnswer(
          journal,
          () => ({ verdict: 'absent' }),
          fixture.IDENTITY.sessionId,
          'mail'
        )
      ).resolves.toEqual({ kind: 'waiting' })
      expect(await fixture.cardOrder(journal)).toEqual(['mail'])
    })
  })

  it('retains queued and legacy chat tasks at restart while withdrawing a derived preamble', async () => {
    const database = await openTestAgentSessionDatabase(fixture.root)
    const open = async () =>
      fixture.journals.track(
        await openAgentSessionJournal({
          identity: fixture.IDENTITY,
          database,
          now: () => (fixture.clock += 1),
          mintEpoch: () => 'task-epoch'
        })
      )
    const earlier = await open()
    const body = {
      ...fixture.message('dispatched task'),
      from: {
        ...fixture.MAIL_SOURCE,
        orchestration: {
          message: 'task' as const,
          runId: 'run',
          taskId: 'task',
          dispatchId: 'dispatch'
        }
      }
    }
    await earlier.queuedMessages.insert({ messageId: 'legacy-task', body })
    await earlier.queuedMessages.insert({
      messageId: 'queued-task',
      body,
      deliveryMode: 'queue',
      unattended: true
    })
    await earlier.queuedMessages.insert({
      messageId: 'derived-preamble',
      body,
      deliveryMode: 'steer',
      unattended: true
    })
    await earlier.close()
    const reopened = await open()
    expect(await fixture.cardOrder(reopened)).toEqual(['legacy-task', 'queued-task'])
    expect((await reopened.queuedMessages.get('derived-preamble'))?.state).toBe('withdrawn')
  })
}
