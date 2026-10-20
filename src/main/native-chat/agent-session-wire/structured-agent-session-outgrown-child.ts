// A child the chat outgrew (signed out, or launched with another permission mode or account) is
// replaced before the next send: agents read their login, account and permission mode only when they
// start.

import { readWholeAgentSessionFailureFact } from '../../../shared/agent-session-failure'
import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import {
  structuredAgentSessionChildHasOpenWork,
  type StructuredAgentSessionChildWorkReads
} from './structured-agent-session-idle-sweep'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import type { AgentChatPermissionMode } from '../../../shared/agent-chat-permission-mode'
import {
  agentSessionAccountHomesEqual,
  type AgentSessionAccountHome
} from '../../../shared/agent-session-account-home'

/** What the check reads of a conversation; every read skips building a snapshot. */
type OutgrownChildReading = Pick<StructuredAgentSessionHostSession, 'child'> & {
  journal: Pick<AgentSessionJournal, 'visitItemsWithLinkage' | 'itemFence' | 'newestTurn'> & {
    submissions(): readonly Pick<AgentJournalSubmission, 'dispatchState' | 'fence' | 'rejection'>[]
  }
}

const signedOut = (failure: unknown): boolean =>
  readWholeAgentSessionFailureFact(failure)?.kind === 'notSignedIn'

/** The running child itself said it is not signed in through a rejected send or a row it wrote.
 *  Its fence scopes both to this child, so a new one has nothing. */
export function structuredAgentSessionChildReportedSignedOut(
  session: OutgrownChildReading
): boolean {
  const { child, journal } = session
  if (!child || child.phase === 'starting' || child.close) {
    return false
  }
  if (
    journal
      .submissions()
      .some(
        (submission) =>
          submission.dispatchState === 'rejected' &&
          submission.fence === child.fence &&
          signedOut(submission.rejection)
      )
  ) {
    return true
  }
  // The session's own agent only: a subagent's sign-in failure says nothing about its parent.
  let found = false
  journal.visitItemsWithLinkage((itemId, _sequence, body, attribution) => {
    found ||=
      body.kind === 'status' &&
      isRootAgentJournalItem(attribution) &&
      signedOut(body.failure) &&
      journal.itemFence(itemId) === child.fence
  })
  return found
}

/** Child work that settled after the lead's newest turn ended: the lead may still owe the turn
 *  that reads its result, which journals nothing until it opens. The idle sweep's window covers
 *  this; a restart before the next send has none, so it waits for that turn. */
function owesWakeUp(
  journal: Pick<AgentSessionJournal, 'newestTurn'>,
  childWork: readonly AgentChildWorkView[] | undefined
): boolean {
  const ended = journal.newestTurn()?.completedAt
  return (childWork ?? []).some(
    (work) => work.settledAt !== undefined && (ended === undefined || work.settledAt > ended)
  )
}

/** Loop-free: a start launches with the same `current` this compares against. */
async function launchedWithOtherPermissionMode(
  child: OutgrownChildReading['child'],
  current: (() => Promise<AgentChatPermissionMode | null>) | undefined
): Promise<boolean> {
  if (!child || child.phase === 'starting' || child.close || !child.permissionMode || !current) {
    return false
  }
  const mode = await current()
  return mode !== null && mode !== child.permissionMode
}

/** Loop-free while a start launches under the account `current` reads; a read that throws is no
 *  answer, so an account still being set up replaces nothing. */
async function launchedUnderOtherAccount(
  child: OutgrownChildReading['child'],
  current: (() => Promise<AgentSessionAccountHome | null>) | undefined
): Promise<boolean> {
  if (!child || child.phase === 'starting' || child.close || !child.accountHome || !current) {
    return false
  }
  const home = await current().catch(() => null)
  return home !== null && !agentSessionAccountHomesEqual(home, child.accountHome)
}

/** For a caller inside the session's serialize, before it hands the next send to the child. Work
 *  the child still owes keeps it, as it keeps an idle one from the sweep. A stop that fails leaves
 *  the close begun, which the start joins. */
export async function retireOutgrownStructuredAgentSessionChild(
  sessionId: string,
  session: OutgrownChildReading | undefined,
  deps: {
    /** `childWork`: the records, read only for endings the lead has yet to answer. */
    work: StructuredAgentSessionChildWorkReads & {
      childWork: () => readonly AgentChildWorkView[] | undefined
    }
    /** The mode a start of the chat would launch with now. */
    launchPermission?: () => Promise<AgentChatPermissionMode | null>
    /** The account a start of the chat would launch under now; null when it keeps its own. */
    launchAccountHome?: () => Promise<AgentSessionAccountHome | null>
    stopAgent: (sessionId: string) => Promise<void>
    logger: StructuredAgentSessionLogger
  }
): Promise<void> {
  if (
    !session ||
    !(
      structuredAgentSessionChildReportedSignedOut(session) ||
      (await launchedWithOtherPermissionMode(session.child, deps.launchPermission)) ||
      (await launchedUnderOtherAccount(session.child, deps.launchAccountHome))
    ) ||
    structuredAgentSessionChildHasOpenWork(deps.work) ||
    owesWakeUp(session.journal, deps.work.childWork())
  ) {
    return
  }
  await deps.stopAgent(sessionId).catch((error: unknown) =>
    deps.logger.warn('replacing an outgrown agent failed', {
      scope: 'outgrown-child',
      sessionId,
      error
    })
  )
}
