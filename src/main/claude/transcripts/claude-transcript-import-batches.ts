import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { journalLifecycleItemMutation } from '../../native-chat/agent-session-journal/writing/journal-lifecycle-mutation'
import {
  continuedOutsideNotice,
  continuedOutsideRecordId,
  type HistoryCatchUpPlan
} from '../../native-chat/agent-session-wire/acquisition/structured-agent-session-history-catch-up'
import { createHistoryCatchUpBatches } from '../../native-chat/agent-session-wire/acquisition/structured-agent-session-history-catch-up-batches'
import type { ClaudeTranscriptItemReader } from './claude-transcript-item-reader'
import { isCompactionRow } from './claude-transcript-compaction-recovery'

/** Turns an imported transcript's rows into catch-up commits, with the "continued outside" divider. */
export async function claudeTranscriptImportBatches(input: {
  rows: ReturnType<typeof journalLifecycleItemMutation>[]
  saved: ClaudeTranscriptItemReader['saved']
  dependencies: ClaudeTranscriptItemReader['dependencies']
  /** Whether the divider reads as rewound; null when the chat holds nothing for one to follow. */
  rewound: boolean | null
  sessionId: string
  epoch: string
  providerSessionId: string
  uuids: string[]
  check: () => void
}): Promise<HistoryCatchUpPlan[] | null> {
  const { rows, saved, dependencies } = input
  // A row that renders nothing adds no divider either; a compaction row alone is not outside work.
  const revised = new Set(
    rows.flatMap((row) => {
      const key = agentJournalItemKey(row.identity)
      return row.kind === 'item' && saved(key) ? [key] : []
    })
  )
  // Every commit checks the items the rows depend on that none of them rewrites.
  const batch = createHistoryCatchUpBatches((first) => {
    for (const [key, item] of dependencies) {
      if (!revised.has(key)) {
        first.expectItem(key, { canonicalItemId: item.itemId, revision: item.revision })
      }
    }
  })
  const firstCreated = rows.find(
    (row) =>
      row.kind === 'item' &&
      row.body.kind !== 'turn' &&
      !isCompactionRow(row.body) &&
      !dependencies.has(agentJournalItemKey(row.identity))
  )
  if (input.rewound !== null && firstCreated) {
    batch.push(
      journalLifecycleItemMutation(
        { turnScope: AGENT_JOURNAL_THREAD_SCOPE },
        {
          provider: 'legacy',
          agent: 'claude',
          sessionId: input.sessionId,
          recordId: continuedOutsideRecordId(agentJournalItemKey(firstCreated.identity))
        },
        continuedOutsideNotice(input.rewound)
      )
    )
  }
  for (const row of rows) {
    const existing = saved(agentJournalItemKey(row.identity))
    if (existing && row.kind === 'item') {
      batch.revise(row, { canonicalItemId: existing.itemId, revision: existing.revision })
    } else {
      batch.push(row)
    }
    await batch.pause()
  }
  input.check()
  return await batch.finish('claude-history-import', [
    input.epoch,
    input.providerSessionId,
    input.uuids
  ])
}
