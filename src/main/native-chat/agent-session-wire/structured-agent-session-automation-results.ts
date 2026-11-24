// Automation results the person saw as notes ride ahead of their next words, once, inside the
// serialized handover so two devices sending at once cannot both carry the same note.

import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalMessageItem,
  type AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from '../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import {
  agentSessionSendCarriesStoppedHistory,
  agentSessionSendDeliversStoppedHistory,
  messageWords,
  refusedBeforeWrite
} from '../../../shared/agent-session/lifecycle/stopping/agent-session-stopped-history'
import {
  automationResultNoteBody,
  automationResultNoteClientMessageId,
  automationResultsPreamble,
  automationResultNoteOf,
  type AutomationResultNote
} from '../../../shared/bots/bot-automation-result-note'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

type AutomationResultsJournal = Pick<AgentSessionJournal, 'appendItem'> & {
  reads: Pick<AgentSessionJournal['reads'], 'automationResultNotes'>
}

/** Only a person's words-only, turn-opening message carries anything ahead of its words. */
export function sendCarriesRideAlong(
  turnScope: AgentJournalTurnScope,
  submission: AgentJournalSubmission,
  body: AgentJournalMessageItem
): boolean {
  return (
    turnScope.kind === 'thread' &&
    agentSessionSendDeliversStoppedHistory(submission, body) &&
    agentSessionSendCarriesStoppedHistory(body)
  )
}

/** Unread notes, those a refused send claimed, and those this send claimed (a fresh retry re-carries them). */
export async function carriedAutomationResults(
  journal: AutomationResultsJournal,
  turnScope: AgentJournalTurnScope,
  submission: AgentJournalSubmission,
  body: AgentJournalMessageItem
): Promise<AutomationResultNote[]> {
  if (!sendCarriesRideAlong(turnScope, submission, body)) {
    return []
  }
  // Results from before a context clear belong to the conversation the agent no longer has.
  const { items, submissions } = await journal.reads.automationResultNotes()
  const refused = (carrierId: string) => {
    const carrier = submissions.find((send) => send.clientMessageId === carrierId)
    return carrier !== undefined && refusedBeforeWrite(carrier)
  }
  return items.flatMap(({ body: item }) => {
    const note = item.kind === 'status' ? automationResultNoteOf(item) : null
    return note &&
      (note.readWith === undefined ||
        note.readWith === submission.clientMessageId ||
        refused(note.readWith))
      ? [note]
      : []
  })
}

/** Revise each note as read with this send before the provider sees it: at most once to the agent. */
export async function markAutomationResultsRead(
  journal: AutomationResultsJournal,
  notes: readonly AutomationResultNote[],
  clientMessageId: string,
  fence: number
): Promise<void> {
  for (const note of notes) {
    if (note.readWith === clientMessageId) {
      continue
    }
    const read = { ...note, readWith: clientMessageId }
    await journal.appendItem(
      { provider: 'orca', clientMessageId: automationResultNoteClientMessageId(note.runId) },
      automationResultNoteBody(read),
      { fence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  }
}

/** What the agent is told of `notes`; nothing when there are none. */
export function automationResultsRideAlong(notes: readonly AutomationResultNote[]): string[] {
  return notes.length === 0
    ? []
    : [
        automationResultsPreamble(notes, (at) =>
          new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        )
      ]
}

/** A words-only send with `parts` ahead of its words, each on its own paragraph. */
export function withRideAlong(
  body: AgentJournalMessageItem,
  parts: readonly string[]
): AgentJournalMessageItem {
  if (parts.length === 0) {
    return body
  }
  return { ...body, blocks: [{ type: 'text', text: [...parts, messageWords(body)].join('\n\n') }] }
}
