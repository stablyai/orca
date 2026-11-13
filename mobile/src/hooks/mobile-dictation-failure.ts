import { errorMessage } from '../../../src/shared/error-message'
import {
  isDictationSetupRequiredError,
  isSpeechlessServerError
} from '../dictation/mobile-dictation-setup'
import type { MobileDictationEngine } from './mobile-dictation-device-engine'
import type { MobileDictationRecording } from './mobile-dictation-recording'
import type { MobileDictationRun } from './mobile-dictation-engine-run'

// Retry plays the recording to the computer, so it needs the whole recording and an engine that may use the computer (not This phone).
export function mobileDictationFailureRetryable(
  recording: MobileDictationRecording,
  engine: MobileDictationEngine
): boolean {
  return recording.complete && recording.bytes > 0 && (engine.kind === 'host' || engine.fallback)
}

// A computer that needs setup or an update refuses every Retry the same way; those keep today's path (words inserted, setup sheet or toast).
function retryCanSucceed(err: unknown): boolean {
  const message = errorMessage(err)
  return !isDictationSetupRequiredError(message) && !isSpeechlessServerError(message)
}

// Never lose speech quietly: a retryable failure keeps the recording and the words so far for Retry; otherwise the words so far are inserted, as before.
export function concludeMobileDictationFailure(
  run: Pick<
    MobileDictationRun,
    'recording' | 'engine' | 'keptTranscript' | 'onTranscript' | 'reportError'
  >,
  dictationId: string,
  err: unknown,
  retryable = mobileDictationFailureRetryable(run.recording.current, run.engine.current)
): void {
  if (retryable && retryCanSucceed(err)) {
    run.reportError(err, true)
    return
  }
  run.recording.current.clear()
  const kept = run.keptTranscript.take(dictationId)
  if (kept) {
    run.onTranscript.current(kept, { partial: true })
  }
  run.reportError(err)
}
