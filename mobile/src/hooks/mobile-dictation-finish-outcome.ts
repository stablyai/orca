import { dictationFinishReplySchema } from '../dictation/dictation-reply-schema'
import { rpcPayloadMember } from '../transport/rpc-reader-payload'

export const MOBILE_DICTATION_NO_SPEECH_MESSAGE = 'No speech detected.'

export type MobileDictationFinishOutcome = {
  /** Trimmed transcript to insert; empty when nothing was committed. */
  text: string
  /** Shown after the text is inserted, or alone when there is no text. */
  errorMessage: string | null
}

/**
 * Reads a current finish reply. `streamFailure` is the provider message a chunk already reported;
 * the host repeats that same failure in the reply's `error`, so it is shown once, not twice.
 * Throws on a null or absent body, as the transcript read always has, so the caller's cancel runs.
 */
export function readDictationFinish(
  finished: unknown,
  streamFailure: string | null
): MobileDictationFinishOutcome {
  const transcript = rpcPayloadMember(finished, 'text')
  const text = typeof transcript === 'string' ? transcript.trim() : ''
  const reportedFailure = dictationFinishReplySchema.parse(finished).error?.trim() || null
  const providerFailure = streamFailure ?? reportedFailure
  return {
    text,
    errorMessage: providerFailure ?? (text ? null : MOBILE_DICTATION_NO_SPEECH_MESSAGE)
  }
}

/** Inserts the text first, then reports the failure, so a partial transcript is never silent. */
export function deliverDictationFinish(
  outcome: MobileDictationFinishOutcome,
  onTranscript: (text: string) => void,
  onFailure: (error: Error) => void
): void {
  if (outcome.text) {
    onTranscript(outcome.text)
  }
  if (outcome.errorMessage) {
    onFailure(new Error(outcome.errorMessage))
  }
}
