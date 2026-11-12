import { seedTestJournalHistoricalRows } from '../replay/journal-historical-inputs.test-support'
import { openTestJournalHostDatabase } from '../store-lifecycle/journal-host-database-test-support'
import type { createFixture } from './queued-message-pause-contract-test-fixture'
import { describe, expect, it } from 'vitest'
import { agentSessionRecordFixture } from '../../testing/agent-session-record-test-fixture'
import { encodeAgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record-stored-form'
import type { JournalAutomaticSelection } from '../journal-automatic-submission'

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
      const record = agentSessionRecordFixture({ sessionId: fixture.IDENTITY.sessionId })
      openTestJournalHostDatabase(fixture.root)
        .db.prepare('INSERT INTO agent_session_records(session_id,record_json) VALUES(?,?)')
        .run(record.sessionId, JSON.stringify(encodeAgentSessionRecord(record)))
      const journal = await fixture.open()
      await fixture.queueDraft(journal, 'draft-1')
      await fixture.userStop(journal)
      const selection: JournalAutomaticSelection = {
        authority: {
          handle: journal.observationHandle(),
          record: {
            currentFence: 1,
            ownerObservation: { claimStatus: 'live', unreconciled: false, handoffStage: null }
          },
          child: null,
          handingOver: [],
          continuingUnadmitted: [],
          finalizing: [],
          openedThrough: journal.openingCursor(),
          operationalRevision: 0
        },
        child: null,
        steering: { kind: 'codex-unavailable' }
      }
      const automatic = (clientMessageId: string) =>
        journal.claimAutomaticSubmission(
          { clientMessageId, fence: 1 },
          async () => selection,
          () => 'owed'
        )
      expect(await automatic('drain-1')).toEqual({ kind: 'waiting' })
      expect(await journal.reads.submission('drain-1')).toBeUndefined()
      expect((await journal.queuedMessages.get('draft-1'))?.state).toBe('waiting')
      await journal.appendQueueResume(1)
      expect(await automatic('drain-after-resume')).toEqual({
        kind: 'claimed',
        messageId: 'draft-1',
        clientMessageId: 'drain-after-resume'
      })
      await fixture.queueDraft(journal, 'draft-2')
      await journal.appendStopEvent({ reason: 'user-stop' }, 1)
      await journal.appendSubmission(
        {
          clientMessageId: 'send-now-1',
          payloadFingerprint: fixture.fingerprintOf('draft-2'),
          body: fixture.message('draft-2'),
          fence: 1,
          handoverRecorded: true
        },
        { messageId: 'draft-2', expect: 'waiting' }
      )
      expect((await journal.queuedMessages.get('draft-2'))?.state).toBe('dispatched')
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
    const row = (seq: number) => ({ v: 4, epoch: 'historical', seq, fence: 0, ts: 1_000 })
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
        }
      ],
      true
    )
    const db = openTestJournalHostDatabase(fixture.root).db
    const source = db.prepare('SELECT generation,through_seq FROM journal_outcome_epochs').get()!
    db.prepare(
      "INSERT INTO journal_outcomes (generation,seq,field,entry_key,format,ordinal,value_json,deleted) VALUES (?,?,'submissions',?,2,'s0000000000000001:0000000000000001','null',1)"
    ).run(source.generation, Number(source.through_seq) + 1, JSON.stringify('retired-person'))
    db.prepare('UPDATE journal_outcome_epochs SET through_seq=through_seq+1').run()
    const restored = await fixture.open()
    expect(await restored.reads.submission('retired-person')).toBeUndefined()
    expect((await restored.queuedMessages.nextInputCard())?.messageId).toBe('W')
    expect(await fixture.reason(restored)).toBeNull()
  })
}
