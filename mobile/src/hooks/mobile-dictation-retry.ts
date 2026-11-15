import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { createMobileDictationId } from './mobile-dictation-session-state'
import {
  concludeMobileDictationFailure,
  mobileDictationFailureRetryable
} from './mobile-dictation-failure'
import {
  releaseMobileDictationEngine,
  type MobileDictationRun
} from './mobile-dictation-engine-run'
import { replayMobileDictationToHost } from './mobile-dictation-host-start'

// A dictation failed after it began hearing: stop it, and keep its recording for Retry when the computer can hear it again.
export function failActiveMobileDictation(
  run: MobileDictationRun,
  dictationId: string,
  err: unknown
): void {
  if (run.activeId.current !== dictationId) {
    return
  }
  run.activeId.current = null
  const retryable = mobileDictationFailureRetryable(run.recording.current, run.engine.current)
  run.closeDictationAudio()
  void releaseMobileDictationEngine(run, run.client.current, dictationId)
  concludeMobileDictationFailure(run, dictationId, err, retryable)
}

// Retry: the kept recording goes to the computer as a new dictation (seq from 0), already stopped, so it finishes as soon as it has been sent.
export async function retryMobileDictationOnHost(
  run: MobileDictationRun,
  client: RpcClient
): Promise<void> {
  const generation = run.generation.current + 1
  run.generation.current = generation
  const dictationId = createMobileDictationId()
  run.activeId.current = dictationId
  run.stopWhenStarted.current = true
  run.applyStatus('processing', true)
  run.showEngine('computer')
  await replayMobileDictationToHost(run, client, dictationId, generation)
}
