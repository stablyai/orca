import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session/journal/agent-session-journal-types'

type ChainSubmission = Pick<AgentJournalSubmission, 'clientMessageId' | 'providerItemId' | 'origin'>

/** What a chain derivation looked at: distinct rows and submissions, and every field read in total. */
export type ChainReads = { visited: Set<string>; total: number }

export const chainReads = (): ChainReads => ({ visited: new Set(), total: 0 })

/** Rows the derivation looks at: each read of a row's fields counts, and marks that row visited. */
export function countedItems(
  items: readonly AgentJournalRenderItem[],
  reads: ChainReads
): AgentJournalRenderItem[] {
  return items.map((item, index) => {
    const mark = () => {
      reads.visited.add(`item-${index}`)
      reads.total += 1
    }
    return {
      revision: item.revision,
      sequence: item.sequence,
      observedAt: item.observedAt,
      get itemId() {
        mark()
        return item.itemId
      },
      get body() {
        mark()
        return item.body
      },
      get turnScope() {
        mark()
        return item.turnScope
      },
      get agentId() {
        mark()
        return item.agentId
      }
    }
  })
}

export function countedSubmissions(
  submissions: readonly ChainSubmission[],
  reads: ChainReads
): ChainSubmission[] {
  return submissions.map((submission, index) => {
    const mark = () => {
      reads.visited.add(`submission-${index}`)
      reads.total += 1
    }
    return {
      get clientMessageId() {
        mark()
        return submission.clientMessageId
      },
      get providerItemId() {
        mark()
        return submission.providerItemId
      },
      get origin() {
        mark()
        return submission.origin
      }
    }
  })
}
