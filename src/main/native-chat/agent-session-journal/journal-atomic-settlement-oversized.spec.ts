import type { createFixture } from './journal-atomic-settlement-contract-test-fixture'
import { expect, it } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalSnapshot
} from '../../../shared/agent-session-journal-types'
import { settleObservedExitForTest } from '../agent-session-wire/structured-agent-session-observed-exit.test-fixture'
import { openTestJournalHostDatabase } from './journal-host-database-test-support'
import { MAX_JOURNAL_LIFECYCLE_BATCH_BYTES } from './journal-row-schema'

export function registerJournalAtomicSettlementOversizedTests(
  fixture: ReturnType<typeof createFixture>
): void {
  it('uses an ordinary recovered tombstone when the settlement namespace exceeds the batch cap', async () => {
    const identity = { provider: 'orca' as const, clientMessageId: 'remove-item' }
    await fixture.journal.appendItem(
      identity,
      { kind: 'status', text: 'remove me' },
      {
        fence: 7,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      }
    )
    const before = fixture.journal.cursor()
    const input = {
      settlementId: 'x'.repeat(MAX_JOURNAL_LIFECYCLE_BATCH_BYTES),
      fence: 7,
      recovered: true as const,
      mutations: [{ kind: 'tombstone' as const, identity }]
    }
    await fixture.journal.appendLifecycleBatch(input)
    expect(fixture.journal.snapshot().items).toEqual([])
    expect(fixture.journal.cursor().sequence).toBe(before.sequence + 1)
    expect(fixture.rows().at(-1)).toMatchObject({ kind: 'tombstone', recovered: true })
    await fixture.journal.appendLifecycleBatch(input)
    expect(fixture.journal.cursor().sequence).toBe(before.sequence + 1)
  })

  it.each(['startup', 'stop'] as const)(
    'rolls back the %s submission verdict with its oversized item',
    async (mode) => {
      await fixture.journal.appendSubmission({
        clientMessageId: 'unanswered',
        payloadFingerprint: 'unanswered',
        fence: 7,
        handoverRecorded: true,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'next' }] }
      })
      await fixture.journal.resolveDispatch({
        clientMessageId: 'unanswered',
        state: 'pending',
        fence: 7,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
      if (mode === 'stop') {
        await fixture.journal.appendStopEvent({ reason: 'user-stop' }, 7)
      }
      await fixture.journal.appendItem(
        { provider: 'orca', clientMessageId: 'oversized-call' },
        {
          kind: 'tool-call',
          name: 'Write',
          input: 'x'.repeat(MAX_JOURNAL_LIFECYCLE_BATCH_BYTES),
          state: 'running'
        },
        { fence: 7, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      const input = {
        journal: fixture.journal,
        sessionId: fixture.SESSION,
        fence: 7,
        settlementId: `${mode}:7`,
        verdict: { state: 'interrupted' as const, completedAt: 1_000 },
        pendingSubmissionReason: 'owner exited',
        showUnexpectedExitOutcome: mode === 'startup',
        ...(mode === 'startup' ? { exitedDuringStartup: { generation: 'start-7' } } : {})
      }
      const database = openTestJournalHostDatabase(fixture.root)
      const before = fixture.journal.snapshot()
      const diskBefore = fixture.rows()
      const published: AgentJournalSnapshot[] = []
      fixture.journal.observeCommits(() => published.push(fixture.journal.snapshot()))
      database.db.exec(`CREATE TEMP TRIGGER reject_submission_settlement_item
    BEFORE INSERT ON journal_rows
    WHEN NEW.session_id = '${fixture.SESSION}' AND json_extract(NEW.row_json, '$.recovered') = 1
      AND json_extract(NEW.row_json, '$.kind') = 'item'
    BEGIN SELECT RAISE(ABORT, 'item rejected after submission'); END`)
      expect(await settleObservedExitForTest(input)).toMatchObject({ ok: false })
      expect(fixture.journal.snapshot()).toEqual(before)
      expect(fixture.rows()).toEqual(diskBefore)
      expect(published).toEqual([])
      database.db.exec('DROP TRIGGER reject_submission_settlement_item')
      expect(await settleObservedExitForTest(input)).toMatchObject({ ok: true })
      expect(fixture.journal.submission('unanswered')).toMatchObject({
        dispatchState: 'rejected',
        recovered: true,
        rejection: { kind: mode === 'stop' ? 'cancelled' : 'providerStartFailed' }
      })
      const committed = fixture.rows().slice(diskBefore.length)
      expect(committed.filter((row) => row.kind === 'dispatch')).toHaveLength(1)
      expect(published).toEqual([fixture.journal.snapshot()])
      expect(await settleObservedExitForTest(input)).toMatchObject({ ok: true })
      expect(fixture.rows().slice(diskBefore.length)).toEqual(committed)
      expect(published).toHaveLength(1)
    }
  )
}
