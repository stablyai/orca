import type { JournalConnectorReplyOutcome } from '../../shared/agent-session/journal/journal-connector-reply'

// The kill-switch drain's own words for a row with no prose; the cloud words the outbox's.
const NO_ANSWER = 'I finished without writing a reply. Ask again if you still need one.'
const TOOLS_RAN_NOTE = 'I may have already taken some actions, so check before asking again.'

/** What the thread reads for an outcome with no prose (design §5). */
export function outcomeSentence(
  outcome: JournalConnectorReplyOutcome,
  hostName: string,
  toolsRan?: boolean
): string {
  switch (outcome) {
    case 'no_answer':
      return toolsRan ? `${NO_ANSWER} ${TOOLS_RAN_NOTE}` : NO_ANSWER
    case 'answered':
    case 'quiet':
      return `Done on ${hostName}, without a written answer.`
    case 'interrupted':
    case 'failed':
      return `The agent on ${hostName} stopped before it answered. Send again to retry.`
    case 'cancelled':
    case 'withdrawn':
      return `Stopped on ${hostName}.`
    case 'cleared':
      return 'The chat was cleared in Orca before this was answered. Ask again.'
    case 'not_found':
      return `Orca on ${hostName} no longer has this request. Ask again.`
    case 'unattributed':
      return `Done on ${hostName}, answered together with the earlier messages.`
  }
}
