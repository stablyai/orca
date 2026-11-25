import type { JournalKeyedRead } from '../journal-keyed-storage'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  isStructuredAgentSessionStopNote,
  STOP_NOTE_CANCELLATION_REQUESTED
} from '../../../../shared/agent-session/view/structured-agent-session-stop-note-identity'

/** The recorded turn end supersedes the earlier unconfirmed Stop for display only. */
export function projectJournalStopNote(
  item: AgentJournalRenderItem,
  items: JournalKeyedRead<string, AgentJournalRenderItem>
): AgentJournalRenderItem {
  if (
    item.body.kind !== 'status' ||
    item.body.failure?.kind !== 'cancelUnconfirmed' ||
    item.turnScope?.kind !== 'turn' ||
    !isStructuredAgentSessionStopNote(item.itemId)
  ) {
    return item
  }
  const body =
    item.turnScope?.kind === 'turn' ? items.get(item.turnScope.turnItemId)?.body : undefined
  return projectJournalStopNoteForTurnState(
    item,
    body?.kind === 'turn'
      ? body.state
      : body?.kind === 'status'
        ? body.turnLifecycle?.state
        : undefined
  )
}

export function projectJournalStopNoteForTurnState(
  item: AgentJournalRenderItem,
  state: unknown
): AgentJournalRenderItem {
  if (
    item.body.kind === 'status' &&
    item.body.failure?.kind === 'cancelUnconfirmed' &&
    item.turnScope?.kind === 'turn' &&
    isStructuredAgentSessionStopNote(item.itemId) &&
    state === 'interrupted'
  ) {
    return { ...item, body: { kind: 'status', text: STOP_NOTE_CANCELLATION_REQUESTED } }
  }
  return item
}
