import {
  droidVerdictRetryDelayMs,
  readDroidTurnVerdictAsync,
  type DroidTurnVerdict
} from '../../../shared/agent-hook-listener/providers/droid/droid-turn-outcome'
import {
  readLastAssistantFromTranscriptAsync,
  type AssistantTranscriptFormat
} from '../../../shared/agent-hook-listener/transcript-reader'
import {
  claudeReplyModelRetryDelayMs,
  readClaudeTranscriptReplyModelAsync
} from '../../../shared/agent-hook-listener/providers/claude/transcripts/claude-transcript-reply-model'
import {
  ASSISTANT_MESSAGE_RETRY_ATTEMPTS,
  ASSISTANT_MESSAGE_RETRY_MS,
  COPILOT_STOP_REPLY_RETRY_ATTEMPTS
} from './server-constants'

/** What one Stop's transcript reads found: the reply text it came without, a Droid turn verdict,
 *  the model that wrote a Claude reply. */
export type StopTranscriptFind = { text?: string; verdict?: DroidTurnVerdict; model?: string }

/** One transcript read: undefined while it has not found what it reads, then what to publish. */
export type StopTranscriptRead = {
  readonly scan: (
    keepReading: () => boolean,
    scannedSize: number | undefined,
    onError: () => void
  ) => Promise<StopTranscriptFind | undefined>
  readonly retryDelayMs: (attempt: number) => number | undefined
}

const REPLY_RETRY_ATTEMPTS: Record<AssistantTranscriptFormat, number> = {
  copilot: COPILOT_STOP_REPLY_RETRY_ATTEMPTS,
  shared: ASSISTANT_MESSAGE_RETRY_ATTEMPTS
}

export const replyRead = (
  transcriptPath: string,
  format: AssistantTranscriptFormat
): StopTranscriptRead => ({
  scan: async (keepReading, scannedSize, onError) => {
    const text = await readLastAssistantFromTranscriptAsync(
      transcriptPath,
      keepReading,
      scannedSize,
      onError,
      format
    )
    return text ? { text } : undefined
  },
  retryDelayMs: (attempt) =>
    attempt < REPLY_RETRY_ATTEMPTS[format] ? ASSISTANT_MESSAGE_RETRY_MS : undefined
})

export const verdictRead = (transcriptPath: string): StopTranscriptRead => ({
  scan: async (keepReading, _scannedSize, onError) => {
    const verdict = await readDroidTurnVerdictAsync(transcriptPath, keepReading, onError)
    return verdict === undefined ? undefined : { verdict: verdict ?? undefined }
  },
  retryDelayMs: droidVerdictRetryDelayMs
})

export const replyModelRead = (transcriptPath: string): StopTranscriptRead => ({
  scan: async (keepReading, scannedSize, onError) => {
    const model = await readClaudeTranscriptReplyModelAsync(
      transcriptPath,
      keepReading,
      scannedSize,
      onError
    )
    // null: the transcript ends on a newer user record, so this reply isn't written yet.
    return model ? { model } : undefined
  },
  retryDelayMs: claudeReplyModelRetryDelayMs
})
