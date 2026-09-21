import type { NativeChatClippedPayload } from '../../../shared/native-chat-types'
import {
  getDefaultJournalPayloadRetention,
  journalPayloadDigest,
  type JournalPayloadRetention
} from '../../native-chat/agent-session-journal/journal-payload-store'

export type WorkerTranscriptBoundOptions = {
  payloadScope?: string
  /** Explicit retention; defaults to the process-wide journal payload retention. */
  retention?: JournalPayloadRetention | null
}

export type WorkerTranscriptRetentionState = {
  /** Retains the complete (redacted) text of every clipped block; null keeps the legacy lossy clip. */
  retention: JournalPayloadRetention | null
  /** Scope recorded against retained digests (for example `dispatch:<id>`), so a
   *  later payload read can prove this reader's reference to it. */
  payloadScope: string | undefined
}

export function workerTranscriptRetentionState(
  options: WorkerTranscriptBoundOptions | undefined
): WorkerTranscriptRetentionState {
  return {
    retention:
      options?.retention === undefined ? getDefaultJournalPayloadRetention() : options.retention,
    payloadScope: options?.payloadScope
  }
}

/** Digests and retains the REDACTED text: the retained bytes must never carry a
 *  capability token that the head already hid. */
export function retainClippedTranscriptText(
  state: WorkerTranscriptRetentionState,
  redacted: string,
  head: string
): { text: string; clipped: NativeChatClippedPayload } {
  const byteLength = Buffer.byteLength(redacted, 'utf8')
  const digest = journalPayloadDigest(redacted)
  let retrievable = false
  if (state.retention !== null) {
    try {
      retrievable = state.retention.retain(digest, redacted, state.payloadScope) === true
    } catch {
      retrievable = false
    }
  }
  // The reference is appended AFTER the legacy marker so old readers see the
  // exact suffix they already know; new readers use the structured field.
  const text = retrievable ? `${head} [full text ${byteLength} bytes, digest ${digest}]` : head
  return { text, clipped: { digest, byteLength, retrievable } }
}
