// The voice model answers some speech itself and hands the rest to the thread; only the hand-offs
// become turns. Each committed transcript segment is therefore kept as its own row, so a spoken
// discussion survives in the chat. Codex publishes `item/completed` after its canonical commit.

import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import type { CodexRowAttribution } from '../background-work/codex-subagent-linkage'
import { readRecord, readString } from '../../app-server/codex-item-field-readers'
import {
  CODEX_JOURNAL_ADMITTED,
  type CodexJournalTranslationAdmission
} from './codex-structured-journal-contracts'
import { NATIVE_CHAT_VOICE_TRANSCRIPT_PRESENTATIONS } from '../../../../shared/native-chat/native-chat-voice-transcript'

export function appendCodexVoiceTranscript(
  sink: StructuredAgentSessionEventSink,
  attributionFor: CodexRowAttribution,
  threadId: string,
  params: unknown
): CodexJournalTranslationAdmission {
  const item = readRecord(readRecord(params).item)
  const itemId = readString(item, 'id')
  const role = readString(item, 'role')
  const text = readString(item, 'text')?.trim()
  if (
    readString(item, 'type') !== 'transcriptSegment' ||
    !itemId ||
    !text ||
    (role !== 'user' && role !== 'assistant')
  ) {
    return CODEX_JOURNAL_ADMITTED
  }
  // Keyed by Codex's item id: a retried notification rewrites the same row.
  const identity = {
    provider: 'orca' as const,
    clientMessageId: `voice-transcript:codex:${JSON.stringify([threadId, itemId])}`
  }
  const body = {
    kind: 'status' as const,
    // Older clients print the words; newer ones label who spoke.
    text,
    presentation: NATIVE_CHAT_VOICE_TRANSCRIPT_PRESENTATIONS[role]
  }
  const attribution = attributionFor(threadId, null)
  const admission = sink.tryAppendItem
    ? sink.tryAppendItem(identity, body, attribution)
    : (sink.appendItem(identity, body, attribution), CODEX_JOURNAL_ADMITTED)
  if (!admission.accepted) {
    return admission
  }
  return sink.tryPublish ? sink.tryPublish() : (sink.publish(), CODEX_JOURNAL_ADMITTED)
}
