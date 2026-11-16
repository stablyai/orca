import type { TraexSession } from './traex-session'
import { traexNonnegativeNumber, traexText } from './traex-protocol'
import { agentJournalItemKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import { readAgentJournalTurn } from '../../shared/agent-session/lifecycle/agent-session-turn-record'

export function observeTraexModelQueue(
  session: TraexSession,
  params: Record<string, unknown>
): void {
  const turnId = traexText(params.turnId)
  if (!turnId || params.threadId !== session.threadId || session.isCompletedTurn(turnId)) {
    return
  }
  const identity = session.timeline?.turnIdentity(turnId)
  const known =
    identity &&
    readAgentJournalTurn(
      session.input.events?.journalItems?.()?.itemBody(agentJournalItemKey(identity)) ?? undefined
    )
  if (known && known.state !== 'running') {
    return
  }
  if (params.state === 'ready') {
    clearTraexModelQueue(session, turnId)
    return
  }
  if (
    (params.state !== 'queued' && params.state !== 'waiting') ||
    (session.activeTurn && session.activeTurn !== turnId)
  ) {
    return
  }
  session.queuedModelTurn = turnId
  session.activeTurn = turnId
  if (!session.compacting) {
    session.timeline?.apply({ type: 'turn.open', turn: turnId, at: Date.now() })
  }
  const position = traexNonnegativeNumber(params.position)
  session.timeline?.apply({
    type: 'activity',
    text:
      position !== undefined && Number.isSafeInteger(position)
        ? `Queued (position ${position})`
        : 'Queued'
  })
}

export function clearTraexModelQueue(session: TraexSession, turnId: string | null): void {
  if (!turnId || session.queuedModelTurn !== turnId) {
    return
  }
  session.queuedModelTurn = null
  if (session.activeTurn === turnId) {
    session.timeline?.apply({ type: 'activity', text: null })
  }
}
