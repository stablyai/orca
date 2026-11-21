import type { JournalSqlReads } from '../../agent-session-journal/journal-sql-reads'
import { copyJournalCurrentWorkAuthority } from '../../agent-session-journal/journal-observer-read'
import { journalSqlWorkAnswerIsCurrent } from '../../agent-session-journal/journal-sql-work-answer'
import { captureHostStructuredAgentSessionWork } from '../observations/structured-agent-session-read-work'
import { structuredAgentSessionOwnerUnverifiable } from '../observations/structured-agent-session-work-policy'
import { sameProviderChild } from '../host/structured-agent-session-provider-child'
import {
  cutClosingStructuredAgentSession,
  type StructuredAgentSessionConversationLifetimeHost
} from './structured-agent-session-conversation-lifetime-host'

export type StructuredAgentSessionCloseWork = {
  /** A replaced source grants no subject, even to an explicit release that joined the read. */
  sessionId: string | null
  state: 'idle' | 'busy' | 'unknown'
}

/** Caller holds host serialization; the resource decision and cut finish before the journal lane releases. */
export async function admitClosingStructuredAgentSession(
  host: StructuredAgentSessionConversationLifetimeHost,
  sessionId: string,
  admit: (work: StructuredAgentSessionCloseWork) => boolean
): Promise<void> {
  const session = host.sessions.get(sessionId)
  const child = session?.child
  const { runtimeState, deps } = host.context()
  const current = () => host.sessions.get(sessionId) === session && session?.child === child
  const ownedWork = () =>
    runtimeState.hasDeliveryWork(sessionId) ||
    runtimeState.acquireAborts.has(sessionId) ||
    host.childWorkOpen(sessionId) ||
    (!!child && (child.phase === 'starting' || !!child.close))
  const finish = (state: StructuredAgentSessionCloseWork['state']) =>
    cutClosingStructuredAgentSession(
      host,
      sessionId,
      () => admit({ sessionId: current() ? sessionId : null, state }) && current()
    )
  if (!session) {
    const record = deps.store.getConversation(sessionId)
    finish(
      !ownedWork() &&
        !runtimeState.hasPendingIngress(sessionId) &&
        record?.ownerObservation.claimStatus === 'released' &&
        !structuredAgentSessionOwnerUnverifiable({ record, child: null })
        ? 'idle'
        : 'unknown'
    )
    return
  }
  const journal = session.journal
  const capture = () =>
    captureHostStructuredAgentSessionWork(
      { store: deps.store, sessions: host.sessions },
      sessionId,
      journal
    )
  runtimeState.sealEventSink(sessionId)
  const read = async (reads: JournalSqlReads): Promise<void> => {
    let state: StructuredAgentSessionCloseWork['state'] = 'unknown'
    try {
      const authority = copyJournalCurrentWorkAuthority(capture())
      const answer = await reads.work({ authority, operation: { kind: 'child-work' } })
      if (
        current() &&
        answer.result.kind === 'child-work' &&
        journalSqlWorkAnswerIsCurrent(journal, capture, authority, answer)
      ) {
        const work = answer.result
        if (
          work.working ||
          work.actionablePrompt ||
          ownedWork() ||
          authority.handingOver.length > 0 ||
          (authority.child?.heldSends?.length ?? 0) > 0
        ) {
          state = 'busy'
        } else if (
          !runtimeState.hasPendingIngress(sessionId) &&
          authority.record &&
          authority.record.ownerObservation.claimStatus !== 'conflicted' &&
          !structuredAgentSessionOwnerUnverifiable({
            record: authority.record,
            child: child && { fence: child.fence }
          }) &&
          !(authority.replaced && authority.record.currentFence <= authority.replaced.fence) &&
          !(child && session.lastEndedChild && sameProviderChild(child, session.lastEndedChild))
        ) {
          state = 'idle'
        }
      }
    } catch (error) {
      deps.logger.warn('reading work before automatic chat close failed', {
        scope: 'automatic-chat-close',
        sessionId,
        error
      })
    }
    finish(state)
  }
  let ordered: Promise<void> | undefined
  try {
    if (!journal.isClosed) {
      ordered = journal.readInOrder(read)
    }
  } catch (error) {
    deps.logger.warn('joining automatic chat close admission failed', {
      scope: 'automatic-chat-close',
      sessionId,
      error
    })
  }
  if (ordered) {
    await ordered
  } else {
    finish('unknown')
  }
}
