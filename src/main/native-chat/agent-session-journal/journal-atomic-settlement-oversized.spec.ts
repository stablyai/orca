import { setTestSettlementFailure } from './journal-native-fixture-test-support'
import type { createFixture } from './journal-atomic-settlement-contract-test-fixture'
import { expect, it } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalSnapshot
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { settleObservedExitForTest } from '../agent-session-wire/structured-agent-session-observed-exit.test-fixture'
import { openTestJournalHostDatabase } from './journal-host-database-test-support'
import { MAX_JOURNAL_LIFECYCLE_BATCH_BYTES } from './journal-row-schema'

export function registerJournalAtomicSettlementOversizedTests(
  fixture: ReturnType<typeof createFixture>
): void {
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
      const database = await openTestJournalHostDatabase(fixture.root)
      const before = fixture.journal.snapshot()
      const diskBefore = await fixture.rows()
      const published: AgentJournalSnapshot[] = []
      fixture.journal.observeCommits(() => published.push(fixture.journal.snapshot()))
      await setTestSettlementFailure(database, {
        sessionId: fixture.SESSION,
        kind: 'item',
        afterSequence: 0
      })
      expect(await settleObservedExitForTest(input)).toMatchObject({ ok: false })
      expect(fixture.journal.snapshot()).toEqual(before)
      expect(await fixture.rows()).toEqual(diskBefore)
      expect(published).toEqual([])
      await setTestSettlementFailure(database, null)
      expect(await settleObservedExitForTest(input)).toMatchObject({ ok: true })
      expect(fixture.journal.submission('unanswered')).toMatchObject({
        dispatchState: mode === 'stop' ? 'unknown' : 'rejected',
        recovered: true,
        ...(mode === 'stop' ? {} : { rejection: { kind: 'providerStartFailed' } })
      })
      const committed = (await fixture.rows()).slice(diskBefore.length)
      expect(committed.filter((row) => row.kind === 'dispatch')).toHaveLength(1)
      expect(published).toEqual([fixture.journal.snapshot()])
      expect(await settleObservedExitForTest(input)).toMatchObject({ ok: true })
      expect((await fixture.rows()).slice(diskBefore.length)).toEqual(committed)
      expect(published).toHaveLength(1)
    }
  )
}
