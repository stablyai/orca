import { seedTestJournalHistoricalRows } from '../replay/journal-historical-inputs.test-support'
import { openTestJournalHostDatabase } from '../store-lifecycle/journal-host-database-test-support'
import type { createFixture } from './queued-message-pause-contract-test-fixture'
import { describe, expect, it } from 'vitest'
import { QueuedMessageNotConsumableError } from './queued-message-consume-error'

export function registerQueuedMessageStopPauseTests(
  fixture: ReturnType<typeof createFixture>
): void {
  describe("the queue's pause, derived from the journal", () => {
    it('does not release a retained failure whose chronology was already made conservative by a real removal', async () => {
      const journal = await fixture.open()
      await fixture.turn(journal, 'accepted')
      const identity = { provider: 'claude', sessionId: 'native-1', uuid: 'F' } as const
      const body = { kind: 'turn', turnId: 'F', state: 'completed', outcome: 'failure' } as const
      const kept = [{ identity, body, ownerFence: 0 }]
      await journal.appendItem(identity, body, { fence: 0, turnScope: { kind: 'thread' } })
      await fixture.queueDraft(journal, 'carried')
      await journal.appendQueueResume(0)
      await journal.write({ kind: 'epoch-replace', reason: 'handle_forked', fence: 0, items: kept })
      expect(await fixture.reason(journal)).toBeNull()
      const later = { ...identity, uuid: 'T' }
      await journal.appendItem(
        later,
        { ...body, turnId: 'T', outcome: 'success' },
        { fence: 0, turnScope: { kind: 'thread' } }
      )
      await journal.appendTombstone(later, { fence: 0 })
      expect(await fixture.reason(journal)).toBe('failed')
      await journal.write({ kind: 'epoch-replace', reason: 'handle_forked', fence: 0, items: kept })
      expect(await fixture.reason(journal)).toBe('failed')
      expect(await journal.queuedMessages.nextInputCard()).toBeNull()
      await journal.appendQueueResume(0)
      expect((await journal.queuedMessages.nextInputCard())?.messageId).toBe('carried')
    })

    it("the queue's own consume is refused in its transaction while the pause holds the card; Send-now is not", async () => {
      const journal = await fixture.open()
      await fixture.queueDraft(journal, 'draft-1')
      await fixture.userStop(journal)
      const consume = (id: string, automatic: boolean) =>
        journal.appendSubmission(
          {
            clientMessageId: id,
            payloadFingerprint: fixture.fingerprintOf('draft-1'),
            body: fixture.message('draft-1'),
            fence: 0,
            handoverRecorded: true
          },
          {
            messageId: 'draft-1',
            expect: 'waiting',
            ...(automatic ? { yieldsToPause: true as const } : {})
          }
        )
      await expect(consume('drain-1', true)).rejects.toBeInstanceOf(QueuedMessageNotConsumableError)
      expect(await journal.reads.submission('drain-1')).toBeUndefined()
      expect((await journal.queuedMessages.get('draft-1'))?.state).toBe('waiting')
      await consume('send-now-1', false)
      expect((await journal.queuedMessages.get('draft-1'))?.state).toBe('dispatched')
    })

    it("a rewind's epoch replacement restates a Stop still pausing, and not one a turn ended", async () => {
      const journal = await fixture.open()
      await fixture.userStop(journal)
      await journal.write({ kind: 'epoch-replace', reason: 'handle_forked', fence: 0, items: [] })
      expect(await fixture.reason(journal)).toBe('stopped')
      await fixture.turn(journal, 'typed')
      await journal.write({ kind: 'epoch-replace', reason: 'handle_forked', fence: 0, items: [] })
      expect(await fixture.reason(journal)).toBeNull()
    })
  })
  it('mail does not lift Stop, while personal acceptance survives transcript removal and restore', async () => {
    let journal = await fixture.open()
    await journal.queuedMessages.insert({
      messageId: 'P',
      body: fixture.message('P'),
      unattended: false,
      deliveryMode: 'queue'
    })
    await fixture.userStop(journal)
    await journal.appendSubmission({
      clientMessageId: 'mail',
      body: fixture.message('mail'),
      payloadFingerprint: 'mail',
      source: { kind: 'agent' },
      origin: 'host',
      handoverRecorded: true,
      fence: 0
    })
    await journal.resolveDispatch({
      clientMessageId: 'mail',
      state: 'accepted',
      providerIdentity: null,
      fence: 0
    })
    expect(await journal.queuedMessages.nextInputCard()).toBeNull()
    expect(await fixture.reason(journal)).toBe('stopped')
    await fixture.turn(journal, 'person')
    await journal.write({ kind: 'epoch-replace', reason: 'handle_forked', fence: 0, items: [] })
    await journal.close()
    journal = await fixture.open()
    expect((await journal.queuedMessages.nextInputCard())?.messageId).toBe('P')
    expect(await fixture.reason(journal)).toBeNull()
  })

  it('clear restatement retains personal members after unattended acceptance releases the others', async () => {
    let journal = await fixture.open()
    for (const [messageId, unattended] of [
      ['P', false],
      ['A', true],
      ['L', undefined]
    ] as const) {
      await journal.queuedMessages.insert({
        messageId,
        body: fixture.message(messageId),
        ...(unattended === undefined ? {} : { unattended })
      })
    }
    await fixture.clearContext(journal)
    await journal.appendSubmission({
      clientMessageId: 'mail',
      body: fixture.message('mail'),
      payloadFingerprint: 'mail',
      source: { kind: 'agent' },
      handoverRecorded: true,
      fence: 0
    })
    await journal.resolveDispatch({
      clientMessageId: 'mail',
      state: 'accepted',
      providerIdentity: null,
      fence: 0
    })
    expect(await fixture.held(journal)).toEqual([
      ['P', true],
      ['A', false],
      ['L', false]
    ])
    await journal.write({ kind: 'epoch-replace', reason: 'handle_forked', fence: 0, items: [] })
    await journal.close()
    journal = await fixture.open()
    expect(
      (await journal.queuedMessages.pauses()).find((pause) => pause.reason === 'cleared')
        ?.messageIds
    ).toEqual(['P'])
    await fixture.turn(journal, 'person')
    expect(await fixture.held(journal)).toEqual([
      ['P', false],
      ['A', false],
      ['L', false]
    ])
  })

  it('a retired accepted outcome still proves a later personal turn lifted Stop', async () => {
    const row = (seq: number) => ({ v: 3, epoch: 'historical', seq, fence: 0, ts: 1_000 })
    seedTestJournalHistoricalRows(
      openTestJournalHostDatabase(fixture.root).db,
      fixture.IDENTITY,
      [
        {
          ...row(1),
          kind: 'epoch',
          reason: 'session_created',
          providerHandle: { kind: 'claude', sessionId: 'native-1', leafUuid: null }
        },
        {
          ...row(2),
          kind: 'queue',
          messageId: 'W',
          change: { op: 'queued', body: fixture.message('W'), position: 1, queuedAt: null }
        },
        {
          ...row(3),
          kind: 'tombstone',
          itemId: 'orca:stop',
          revision: 1,
          stopEvent: { reason: 'user-stop', at: 1_000 }
        },
        {
          ...row(4),
          kind: 'submission',
          clientMessageId: 'retired-person',
          payloadFingerprint: 'person',
          body: fixture.message('person'),
          providerHandle: { kind: 'claude', sessionId: 'native-1', leafUuid: null },
          source: { kind: 'user' },
          handoverRecorded: true
        },
        {
          ...row(5),
          kind: 'dispatch',
          clientMessageId: 'retired-person',
          state: 'accepted',
          providerItemId: null,
          reason: null
        },
        {
          ...row(6),
          kind: 'tombstone',
          itemId: 'orca:retired-person',
          revision: 1,
          retireSubmission: true
        }
      ],
      true
    )
    const restored = await fixture.open()
    expect(await restored.reads.submission('retired-person')).toBeUndefined()
    expect((await restored.queuedMessages.nextInputCard())?.messageId).toBe('W')
    expect(await fixture.reason(restored)).toBeNull()
  })
}
