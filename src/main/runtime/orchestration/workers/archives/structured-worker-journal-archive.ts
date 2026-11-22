/** Bound a structured journal as transcript-shaped output for the terminal view of a structured worker. */

import type { AgentType } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import { projectStructuredItemsToNativeChat } from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { boundWorkerTranscriptTail } from '../transcripts/worker-transcript-payload'

/** A chat worker's output copy, saved by releases before references. */
export type WorkerStructuredJournalArchive = {
  version: 1
  agent: AgentType
  processIncarnation: string
  messages: NativeChatMessage[]
  limited: boolean
  warnings: string[]
}

// A session journal can grow without limit.
const STRUCTURED_ARCHIVE_MAX_BYTES = 262_144

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
