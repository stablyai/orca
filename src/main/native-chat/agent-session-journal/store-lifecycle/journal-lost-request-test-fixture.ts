import { createFixture } from './journal-store-contract-test-fixture'
import { pinTestJournalInputMode } from '../replay/journal-historical-inputs.test-support'
import {
  seedLegacyTestJournal,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalQuestionItem
} from '../../../../shared/agent-session/journal/agent-session-journal-types'

export function createLostRequestFixture(format: 'raw' | 'outcomes') {
  const fixture = createFixture()
  const open = async () => {
    const journal = await fixture.open()
    await journal.restartEvidenceReady()
    return journal
  }

  async function lostQuestion(
    withdrawn = false,
    earlierQuestion = false,
    answeredBefore = false,
    unprovenParentInterruption = false
  ) {
    if (format === 'raw') {
      seedLegacyTestJournal(openTestJournalHostDatabase(fixture.root), {
        identity: fixture.IDENTITY
      })
    }
    const journal = await open()
    if (format === 'raw') {
      pinTestJournalInputMode(journal)
    }
    const turn = await journal.appendItem(
      fixture.item(1),
      { kind: 'turn', turnId: 'turn-1', state: 'running' },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    const scope = { kind: 'turn' as const, turnItemId: turn.itemId }
    const pending: AgentJournalQuestionItem = {
      kind: 'question',
      question: 'Which branch?',
      options: [{ id: 'main', label: 'Main' }],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    }
    if (earlierQuestion) {
      await journal.appendItem(fixture.item(4), pending, { fence: 1, turnScope: scope })
      if (answeredBefore) {
        await journal.appendItem(
          fixture.item(4),
          {
            ...pending,
            resolution: {
              state: 'resolved',
              selectedOptionId: 'main',
              resolvedBy: 'desktop:user',
              resolvedAt: 1005
            }
          },
          { fence: 1, turnScope: scope }
        )
      }
    }
    const question = await journal.appendItem(fixture.item(2), pending, {
      fence: 1,
      turnScope: scope
    })
    const cancelled: AgentJournalQuestionItem = {
      ...pending,
      resolution: {
        state: 'cancelled',
        selectedOptionId: null,
        resolvedBy: null,
        resolvedAt: null
      }
    }
    if (withdrawn) {
      await journal.appendLifecycleBatch({
        settlementId: 'provider-timeline:session-1:g1:1:request-withdrawn',
        fence: 1,
        mutations: [{ kind: 'item', identity: fixture.item(2), body: cancelled, turnScope: scope }]
      })
    }
    if (unprovenParentInterruption) {
      await journal.appendItem(
        fixture.item(1),
        { kind: 'turn', turnId: 'turn-1', state: 'interrupted' },
        { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
    }
    await journal.appendLifecycleBatch({
      settlementId: 'dead-generation:expected-close:session-1:1:g1',
      fence: 1,
      recovered: true,
      mutations: [
        ...(!unprovenParentInterruption
          ? [
              {
                kind: 'item' as const,
                identity: fixture.item(1),
                body: { kind: 'turn' as const, turnId: 'turn-1', state: 'interrupted' as const },
                turnScope: AGENT_JOURNAL_THREAD_SCOPE
              }
            ]
          : []),
        ...(!withdrawn
          ? [
              {
                kind: 'item' as const,
                identity: fixture.item(2),
                body: cancelled,
                turnScope: scope
              }
            ]
          : [])
      ]
    })
    return { journal, scope, pending, question }
  }

  return { fixture, open, lostQuestion }
}
