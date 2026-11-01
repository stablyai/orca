/** Archive structured journals as transcript-shaped evidence with session identity, rather than pretending a PTY or file exists. */

import type { AgentType, NativeChatMessage } from '../../../shared/native-chat-types'
import { projectStructuredItemsToNativeChat } from '../../../shared/structured-agent-session-projection'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { boundWorkerTranscriptTail } from './worker-transcript-payload'
import { readRetiredLineageJournalPage } from './structured-worker-journal-page'

// Same durable bound the terminal archive uses; a session journal can grow without limit.
const STRUCTURED_ARCHIVE_MAX_BYTES = 262_144

export type WorkerStructuredJournalArchive = {
  version: 1
  agent: AgentType
  processIncarnation: string
  messages: NativeChatMessage[]
  limited: boolean
  warnings: string[]
}

/** Redact and bound newest-first so final answers survive; forward wire bounding first would discard them. */
export function boundStructuredJournalTail(items: readonly AgentJournalRenderItem[]): {
  messages: NativeChatMessage[]
  limited: boolean
  warnings: string[]
} {
  return boundWorkerTranscriptTail(
    projectStructuredItemsToNativeChat(items),
    STRUCTURED_ARCHIVE_MAX_BYTES
  )
}

export function buildStructuredJournalArchive(input: {
  agent: AgentType
  processIncarnation: string
  items: readonly AgentJournalRenderItem[]
  hasOlder: boolean
}): WorkerStructuredJournalArchive {
  const bounded = boundStructuredJournalTail(input.items)
  const warnings = [...bounded.warnings]
  if (input.hasOlder) {
    warnings.push('Older journal items were omitted from the bounded archive.')
  }
  if (bounded.limited) {
    warnings.push('The oldest archived journal messages were dropped to fit the size bound.')
  }
  return {
    version: 1,
    agent: input.agent,
    processIncarnation: input.processIncarnation,
    messages: bounded.messages,
    limited: bounded.limited || input.hasOlder,
    warnings
  }
}

/**
 * The archive of a retired lineage whose running session cannot be read: what the latest readable
 * sessions still hold, saying how many later sessions were lost.
 */
export async function captureRetiredLineageArchive(input: {
  agent: AgentType
  processIncarnation: string
  lineage: readonly string[]
}): Promise<WorkerStructuredJournalArchive> {
  const { page, unreadable } = await readRetiredLineageJournalPage(input.lineage)
  const archive = buildStructuredJournalArchive({
    agent: input.agent,
    processIncarnation: input.processIncarnation,
    items: page?.items ?? [],
    hasOlder: page?.hasOlder ?? false
  })
  return { ...archive, warnings: [...archive.warnings, closedSessionsWarning(unreadable, !!page)] }
}

function closedSessionsWarning(unreadable: number, earlierPreserved: boolean): string {
  if (!earlierPreserved) {
    return unreadable > 1
      ? `None of this conversation's ${unreadable} sessions could be read, so its journal could not be preserved.`
      : 'The structured session was already closed, so its journal could not be preserved.'
  }
  return unreadable > 1
    ? `The latest ${unreadable} sessions of this conversation were already closed, so their journals could not be preserved; earlier sessions were.`
    : 'The latest session of this conversation was already closed, so its journal could not be preserved; earlier sessions were.'
}
