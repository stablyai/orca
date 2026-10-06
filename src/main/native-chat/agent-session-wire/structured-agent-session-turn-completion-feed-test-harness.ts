// The completion feed over a session whose journal a test sets by hand, read through the status
// projection the host feeds it.

import type {
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalTurnLifecycle
} from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentSessionTurnCompletionEvent } from '../../../shared/agent-session-wire'
import { projectStructuredAgentSessionStatusState } from '../../../shared/structured-agent-session-projection'
import { StructuredAgentSessionTurnCompletionFeed } from './structured-agent-session-turn-completion-feed'

export const LOCATION = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'git-worktree'
} as const

export const START_FAILURE = 'Claude is not signed in.'

export function turn(
  turnId: string,
  state: AgentJournalTurnLifecycle['state'],
  outcome?: AgentJournalTurnLifecycle['outcome']
): AgentJournalTurnLifecycle {
  return { turnId, state, ...(outcome ? { outcome } : {}) }
}

export function turnItem(
  lifecycle: AgentJournalTurnLifecycle,
  sequence: number
): AgentJournalRenderItem {
  return {
    itemId: `codex:turn:${lifecycle.turnId}`,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'turn', ...lifecycle }
  }
}

export function userEntry(clientMessageId: string, sequence: number): AgentJournalRenderItem {
  return {
    itemId: agentJournalSubmissionKey(clientMessageId),
    revision: 0,
    sequence,
    observedAt: sequence,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: clientMessageId }] }
  }
}

export function sent(
  clientMessageId: string,
  fields: Partial<AgentJournalSubmission> & Pick<AgentJournalSubmission, 'dispatchState'>
): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: clientMessageId,
    providerItemId: null,
    reason: null,
    submittedAt: 10,
    resolvedAt: 20,
    handoverRecorded: true,
    ...fields
  }
}

export const pending = (clientMessageId: string, fence = 1) =>
  sent(clientMessageId, { dispatchState: 'pending', fence, handedOverAt: 11, resolvedAt: null })
export const refused = (clientMessageId: string, reason = START_FAILURE) =>
  sent(clientMessageId, { dispatchState: 'rejected', reason })

export function harness(): {
  feed: StructuredAgentSessionTurnCompletionFeed
  setTurn: (next: AgentJournalTurnLifecycle | null) => void
  setJournal: (
    items: AgentJournalRenderItem[],
    submissions: AgentJournalSubmission[],
    fence?: number
  ) => void
  setCursor: (next: { epoch: string; sequence: number }) => void
  observe: () => void
  events: AgentSessionTurnCompletionEvent[]
  outcomes: () => [string, string][]
  /** Whether each completion said the user is being asked something. */
  awaitingUser: () => boolean[]
  listen: () => () => void
} {
  let items: AgentJournalRenderItem[] = []
  let submissions: AgentJournalSubmission[] = []
  let fence: number | undefined
  let cursor = { epoch: 'epoch-1', sequence: 0 }
  const journal = { cursor: () => cursor }
  const sessions = new Map([['session-1', { journal, params: { location: LOCATION } }]])
  const feed = new StructuredAgentSessionTurnCompletionFeed({
    sessions,
    now: () => 1_700,
    // The status feed's projection, computed as it computes it.
    readStatusState: () => projectStructuredAgentSessionStatusState(items, submissions, fence)
  })
  const events: AgentSessionTurnCompletionEvent[] = []
  return {
    feed,
    setTurn: (next) => {
      items = next ? [turnItem(next, 1)] : []
      submissions = []
    },
    setJournal: (nextItems, nextSubmissions, nextFence) => {
      items = nextItems
      submissions = nextSubmissions
      fence = nextFence
      cursor = { ...cursor, sequence: cursor.sequence + 1 }
    },
    setCursor: (next) => {
      cursor = next
    },
    observe: () => feed.observe('session-1'),
    events,
    outcomes: () =>
      events.flatMap((event): [string, string][] =>
        event.type === 'completion' ? [[event.completion.turnId, event.completion.outcome]] : []
      ),
    awaitingUser: () =>
      events.flatMap((event) =>
        event.type === 'completion' ? [event.completion.awaitingUser === true] : []
      ),
    listen: () => feed.subscribe({ id: 'sub', emit: (event) => events.push(event) })
  }
}
