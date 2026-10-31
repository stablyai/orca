import type {
  AgentSessionHistoryPage,
  AgentSessionHistoryResult
} from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { snapshotLatestTurn } from './agent-session-history-latest-turn'
import type { StructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'

/** Absent projection preserves legacy raw-turn behavior without current prompt IDs. */
export type AgentSessionPublishedWork = Pick<
  StructuredAgentSessionCurrentWork,
  | 'publishedLatestTurn'
  | 'actionablePromptIds'
  | 'actionablePrompts'
  | 'working'
  | 'viewKey'
  | 'workViewKey'
  | 'publishedSubmission'
  | 'restatedSubmissions'
  | 'requestProjection'
>

type PublishedWorkFields = Pick<
  AgentSessionHistoryPage,
  'latestTurn' | 'actionablePromptIds' | 'working'
>

function publishedWorkFields(
  latestTurn: AgentSessionHistoryPage['latestTurn'],
  work: AgentSessionPublishedWork
): PublishedWorkFields {
  const ids = work.actionablePromptIds()
  return {
    latestTurn: work.publishedLatestTurn(latestTurn ?? null),
    ...(Buffer.byteLength(JSON.stringify(ids)) <= 8 * 1024 ? { actionablePromptIds: ids } : {}),
    working: work.working()
  }
}

export function agentSessionPublishedWorkFields(
  journal: AgentSessionJournal,
  work: AgentSessionPublishedWork
): PublishedWorkFields {
  return publishedWorkFields(snapshotLatestTurn(journal.snapshot()), work)
}

/** Page-local effective values; off-page sends ride separately budgeted subscriber batches. */
export function withPublishedWork(
  page: AgentSessionHistoryPage,
  work: AgentSessionPublishedWork | undefined
): AgentSessionHistoryPage {
  if (!work) {
    return page
  }
  return {
    ...page,
    ...publishedWorkFields(page.latestTurn, work),
    submissions: page.submissions.map(work.publishedSubmission)
  }
}

export function withPublishedWorkResult(
  result: AgentSessionHistoryResult,
  work: AgentSessionPublishedWork | undefined
): AgentSessionHistoryResult {
  return work ? { ...result, page: withPublishedWork(result.page, work) } : result
}
