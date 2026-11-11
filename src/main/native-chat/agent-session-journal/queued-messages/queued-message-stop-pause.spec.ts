import { finishTestJournalHistoricalInputs } from '../replay/journal-historical-inputs.test-support'
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
      await journal.replaceEpochItems('handle_forked', 0, kept)
      expect(fixture.reason(journal)).toBeNull()
      const later = { ...identity, uuid: 'T' }
      await journal.appendItem(
        later,
        { ...body, turnId: 'T', outcome: 'success' },
        { fence: 0, turnScope: { kind: 'thread' } }
      )
      await journal.appendTombstone(later, { fence: 0 })
      expect(fixture.reason(journal)).toBe('failed')
      await journal.replaceEpochItems('handle_forked', 0, kept)
      expect(fixture.reason(journal)).toBe('failed')
      expect(journal.queuedMessages.nextInputCard()).toBeNull()
      await journal.appendQueueResume(0)
      expect(journal.queuedMessages.nextInputCard()?.messageId).toBe('carried')
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
      expect(journal.submission('drain-1')).toBeUndefined()
      expect(journal.queuedMessages.get('draft-1')?.state).toBe('waiting')
      await consume('send-now-1', false)
      expect(journal.queuedMessages.get('draft-1')?.state).toBe('dispatched')
    })

    it("a rewind's epoch replacement restates a Stop still pausing, and not one a turn ended", async () => {
      const journal = await fixture.open()
      await fixture.userStop(journal)
      await journal.replaceEpochItems('handle_forked', 0, [])
      expect(fixture.reason(journal)).toBe('stopped')
      await fixture.turn(journal, 'typed')
      await journal.replaceEpochItems('handle_forked', 0, [])
      expect(fixture.reason(journal)).toBeNull()
    })
  })
  it('mail does not lift Stop, while personal acceptance survives transcript removal and restore', async () => {
    let journal = await fixture.open()
    finishTestJournalHistoricalInputs(journal)
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
    expect(journal.queuedMessages.nextInputCard()).toBeNull()
    expect(fixture.reason(journal)).toBe('stopped')
    await fixture.turn(journal, 'person')
    await journal.replaceEpochItems('handle_forked', 0, [])
    await journal.close()
    journal = await fixture.open()
    expect(journal.queuedMessages.nextInputCard()?.messageId).toBe('P')
    expect(fixture.reason(journal)).toBeNull()
  })

  it('clear restatement retains personal members after unattended acceptance releases the others', async () => {
    let journal = await fixture.open()
    finishTestJournalHistoricalInputs(journal)
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
    expect(fixture.held(journal)).toEqual([
      ['P', true],
      ['A', false],
      ['L', false]
    ])
    await journal.replaceEpochItems('handle_forked', 0, [])
    await journal.close()
    journal = await fixture.open()
    expect(
      journal.queuedMessages.pauses().find((pause) => pause.reason === 'cleared')?.messageIds
    ).toEqual(['P'])
    await fixture.turn(journal, 'person')
    expect(fixture.held(journal)).toEqual([
      ['P', false],
      ['A', false],
      ['L', false]
    ])
  })

  it('a retired accepted outcome still proves a later personal turn lifted Stop', async () => {
    const journal = await fixture.open()
    finishTestJournalHistoricalInputs(journal)
    await fixture.queueDraft(journal, 'W')
    await fixture.userStop(journal)
    await fixture.turn(journal, 'retired-person')
    await journal.close()
    const db = openTestJournalHostDatabase(fixture.root).db
    const source = db.prepare('SELECT generation,through_seq FROM journal_outcome_epochs').get()!
    db.prepare(
      "INSERT INTO journal_outcomes (generation,seq,field,entry_key,format,ordinal,value_json,deleted) VALUES (?,?,'submissions',?,2,'s0000000000000001:0000000000000001','null',1)"
    ).run(source.generation, Number(source.through_seq) + 1, JSON.stringify('retired-person'))
    db.prepare('UPDATE journal_outcome_epochs SET through_seq=through_seq+1').run()
    const restored = await fixture.open()
    expect(restored.submission('retired-person')).toBeUndefined()
    expect(restored.queuedMessages.nextInputCard()?.messageId).toBe('W')
    expect(fixture.reason(restored)).toBeNull()
  })
}
