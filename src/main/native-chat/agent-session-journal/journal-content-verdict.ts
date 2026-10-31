import type { AgentJournalContentVerdict } from '../../../shared/agent-session-journal-body-admission'

// Future content outranks adjacent corruption so unsupported history is never discarded.
export function combinedContent(
  ...verdicts: AgentJournalContentVerdict[]
): AgentJournalContentVerdict {
  if (verdicts.includes('unreadable')) {
    return 'unreadable'
  }
  return verdicts.includes('malformed') ? 'malformed' : 'readable'
}

export function fieldsContent(hold: boolean): AgentJournalContentVerdict {
  return hold ? 'readable' : 'malformed'
}
