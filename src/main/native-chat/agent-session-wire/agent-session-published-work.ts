import { finishJournalSteps } from '../agent-session-journal/journal-reconstruction-steps'
import { snapshotLatestTurnSteps, snapshotLatestTurn } from './agent-session-history-latest-turn'
import type { AgentJournalSnapshot } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type {
  AgentSessionHistoryPage,
  AgentSessionHistoryResult
} from '../../../shared/agent-session/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
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
> & { snapshotFields?: PublishedWorkFields } & Partial<
    Pick<
      StructuredAgentSessionCurrentWork,
      | 'restatedSubmissionSteps'
      | 'workingSteps'
      | 'workViewKeySteps'
      | 'actionablePromptSteps'
      | 'revision'
    >
  >

type PublishedWorkFields = Pick<
  AgentSessionHistoryPage,
  'latestTurn' | 'actionablePromptIds' | 'working'
>

function publishedWorkFields(
  latestTurn: AgentSessionHistoryPage['latestTurn'],
  work: AgentSessionPublishedWork
): PublishedWorkFields {
  if (work.snapshotFields) {
    return work.snapshotFields
  }
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
  return finishJournalSteps(agentSessionPublishedWorkFieldSteps(journal, work))
}
export function* agentSessionPublishedWorkFieldSteps(
  journal: AgentSessionJournal,
  work: AgentSessionPublishedWork
): Generator<void, PublishedWorkFields> {
  return (
    work.snapshotFields ??
    publishedWorkFields(yield* snapshotLatestTurnSteps(journal.itemsRead()), work)
  )
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

/** A finite response captures current-work facts beside its published journal view. */
export function capturePublishedWork(
  snapshot: AgentJournalSnapshot,
  work: AgentSessionPublishedWork | undefined
): AgentSessionPublishedWork | undefined {
  return finishJournalSteps(capturePublishedWorkSteps(snapshot, work, false))
}

export function* capturePublishedWorkSteps(
  snapshot: AgentJournalSnapshot,
  work: AgentSessionPublishedWork | undefined,
  finite = true
): Generator<void, AgentSessionPublishedWork | undefined> {
  if (!work) {
    return undefined
  }
  const latest = structuredClone(
    work.publishedLatestTurn(
      finite ? yield* snapshotLatestTurnSteps(snapshot) : snapshotLatestTurn(snapshot)
    )
  )
  const rawPrompts =
    finite && work.actionablePromptSteps
      ? yield* work.actionablePromptSteps(() => true)
      : work.actionablePrompts()
  const prompts: typeof rawPrompts = []
  const ids: string[] = []
  for (const prompt of rawPrompts) {
    prompts.push(structuredClone(prompt))
    ids.push(prompt.itemId)
    yield
  }
  const rawSubmissions =
    finite && work.restatedSubmissionSteps
      ? yield* work.restatedSubmissionSteps()
      : work.restatedSubmissions()
  const submissions: typeof rawSubmissions = []
  const byId = new Map<string, (typeof rawSubmissions)[number]>()
  for (const entry of rawSubmissions) {
    const saved = structuredClone(entry)
    submissions.push(saved)
    byId.set(saved.clientMessageId, saved)
    yield
  }
  const sourceRequests = work.requestProjection(snapshot.sessionId)
  const requests = {
    ...sourceRequests,
    marker: structuredClone(sourceRequests.marker),
    items: prompts
  }
  let idBytes = 2
  for (const id of ids) {
    idBytes += Buffer.byteLength(JSON.stringify(id)) + 1
    yield
    if (idBytes - 1 > 8 * 1024) {
      break
    }
  }
  const working = finite && work.workingSteps ? yield* work.workingSteps() : work.working(),
    view = work.viewKey(),
    workView = finite && work.workViewKeySteps ? yield* work.workViewKeySteps() : work.workViewKey()
  return {
    snapshotFields: {
      latestTurn: latest,
      ...(idBytes - (ids.length ? 1 : 0) <= 8 * 1024 ? { actionablePromptIds: ids } : {}),
      working
    },
    publishedLatestTurn: () => latest,
    actionablePrompts: () => prompts,
    actionablePromptIds: () => ids,
    restatedSubmissions: () => submissions,
    publishedSubmission: (entry) => byId.get(entry.clientMessageId) ?? entry,
    requestProjection: () => requests,
    working: () => working,
    revision: work.revision,
    viewKey: () => view,
    workViewKey: () => workView
  }
}
