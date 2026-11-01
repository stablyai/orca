import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { JournalInputSource } from './journal-input-source-schema'

export function journalInputSourceId(source: JournalInputSource | undefined): string | undefined {
  return source?.kind === 'submission' ? source.clientMessageId : source?.submission.clientMessageId
}

export function journalInputSourceFamily(
  source: JournalInputSource | undefined
): string | undefined {
  return source?.kind === 'submission' ? source.queuedMessageId : source?.submission.queuedMessageId
}

export function journalInputSourceBody(
  source: JournalInputSource | undefined
): AgentJournalMessageItem | null {
  return source?.kind === 'submission'
    ? source.body
    : source?.item.body.kind === 'message'
      ? source.item.body
      : null
}

export function journalInputSourceSequence(
  source: JournalInputSource | undefined
): number | undefined {
  return source?.kind === 'submission' ? source.seq : source?.sequence
}

export function journalInputSourceScope(source: JournalInputSource | undefined) {
  // A historical display scope is not an original row's scope declaration.
  return source?.kind === 'submission' ? source.turnScope : undefined
}
