// Refresh login/permission mode by replacing outgrown children before sending; agents read them only at startup.

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
import type { AgentChatPermissionChoice } from '../../../shared/agent-chat-permission-mode'

type OutgrownChildReading = Pick<StructuredAgentSessionHostSession, 'child'> & {
  journal: Pick<AgentSessionJournal, 'visitItemsWithLinkage' | 'itemFence' | 'newestTurn'> & {
    submissions(): readonly Pick<AgentJournalSubmission, 'dispatchState' | 'fence' | 'rejection'>[]
  }
}

const signedOut = (failure: unknown): boolean =>
  readWholeAgentSessionFailureFact(failure)?.kind === 'notSignedIn'

/** Scope sign-out evidence to this child’s fence so replacement children do not inherit it. */
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
  // A subagent’s sign-in failure says nothing about the parent.
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

/** Wait for the lead’s wake-up after child completion; unlike idle sweep, immediate restart has no window. */
function owesWakeUp(
  journal: Pick<AgentSessionJournal, 'newestTurn'>,
  childWork: readonly AgentChildWorkView[] | undefined
): boolean {
  const ended = journal.newestTurn()?.completedAt
  return (childWork ?? []).some(
    (work) => work.settledAt !== undefined && (ended === undefined || work.settledAt > ended)
  )
}

/** Compare the actual launch mode so replacement cannot loop. */
async function launchedWithOtherPermissionMode(
  child: OutgrownChildReading['child'],
  current: (() => Promise<AgentChatPermissionChoice | null>) | undefined
): Promise<boolean> {
  if (!child || child.phase === 'starting' || child.close || !child.permissionMode || !current) {
    return false
  }
  const mode = await current()
  return mode !== null && mode !== child.permissionMode
}

/** Retire under serialization only when no work is owed; failed Stop leaves a close for startup to join. */
export async function retireOutgrownStructuredAgentSessionChild(
  sessionId: string,
  session: OutgrownChildReading | undefined,
  deps: {
    /** Read records only for child endings the lead has not answered. */
    work: StructuredAgentSessionChildWorkReads & {
      childWork: () => readonly AgentChildWorkView[] | undefined
    }
    launchPermission?: () => Promise<AgentChatPermissionChoice | null>
    stopAgent: (sessionId: string) => Promise<void>
    logger: StructuredAgentSessionLogger
  }
): Promise<void> {
  if (
    !session ||
    !(
      structuredAgentSessionChildReportedSignedOut(session) ||
      (await launchedWithOtherPermissionMode(session.child, deps.launchPermission))
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
