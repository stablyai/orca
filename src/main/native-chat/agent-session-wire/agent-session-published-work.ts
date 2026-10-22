// What a page or frame publishes of the host's current-work projection
// (`structuredAgentSessionCurrentWork`), laid over the page the journal reads.

import type {
  AgentSessionHistoryPage,
  AgentSessionHistoryResult
} from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { snapshotLatestTurn } from './agent-session-history-page'
import type { StructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'

/** The newest turn record as clients are told it, and the prompts still waiting on the person.
 *  Absent, a page states the raw record and no prompt ids, as an older host did. */
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

/** The current-work fields a page carries, for a frame that carries no page. */
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
