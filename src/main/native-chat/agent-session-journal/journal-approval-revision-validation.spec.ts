import type { createFixture } from './journal-terminal-validation-test-fixture'
import { expect, it } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'

export function registerJournalApprovalRevisionValidationTests(
  fixture: ReturnType<typeof createFixture>
): void {
  it('admits an answer on an exhausted approval without changing the saved item', async () => {
    await fixture.saveOldItems([
      {
        itemId: agentJournalItemKey(fixture.identity),
        revision: Number.MAX_SAFE_INTEGER + 1,
        body: fixture.pendingApproval()
      }
    ])
    const before = fixture.journal.snapshot().items[0]
    const cursor = fixture.journal.cursor()
    await expect(
      fixture.journal.appendItem(
        fixture.identity,
        {
          ...fixture.pendingApproval(),
          kind: 'approval',
          resolution: {
            state: 'resolved',
            selectedOptionId: null,
            resolvedBy: 'user',
            resolvedAt: 1_000
          }
        },
        { fence: 8, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
    ).resolves.toBeDefined()
    expect(fixture.journal.cursor().sequence).toBe(cursor.sequence + 1)
    expect(fixture.journal.snapshot().items[0]).toEqual(before)
    await fixture.expectSendStillWritable()
  })
}
