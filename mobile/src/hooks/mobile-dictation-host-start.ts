import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { dictationSessionErrorMessage } from '../dictation/mobile-dictation-setup'
import {
  settledDesktopDictationWork,
  startMobileDictationDesktopSession
} from './mobile-dictation-desktop-start'
import { concludeMobileDictationFailure } from './mobile-dictation-failure'
import type { MobileDictationRun } from './mobile-dictation-engine-run'

export async function startMobileDictationOnHost(
  run: MobileDictationRun,
  client: RpcClient,
  dictationId: string,
  generation: number,
  // A replay (fallback or Retry) keeps the words so far on screen if its start fails.
  replay = false
): Promise<void> {
  await settledDesktopDictationWork(client)
  if (run.generation.current !== generation) {
    return
  }
  await startMobileDictationDesktopSession({
    client,
    dictationId,
    generation,
    getCurrentGeneration: () => run.generation.current,
    getEnabled: () => run.enabled.current,
    getActiveId: () => run.activeId.current,
    clearActiveId: (id) => {
      if (run.activeId.current === id) {
        run.activeId.current = null
      }
    },
    setIdle: () => run.applyStatus('idle', replay),
    commitRecordingStart: (hostDedupesResends) => {
      run.audioPhase.current = 'sending'
      run.pendingChunks.current.clear()
      run.pendingAudioBudget.current.reset(hostDedupesResends)
      // A phone dictation stopped or failed at finish is already processing; it never records again.
      if (run.status.current !== 'processing') {
        run.applyStatus('recording')
      }
      run.showEngine('computer')
      run.sendHeldAudio.current()
      if (run.stopWhenStarted.current) {
        void run.finish.current(dictationSessionErrorMessage('no-speech'))
      }
    },
    rollbackRecordingStart: run.closeDictationAudio
  })
}

// Play the kept recording to the computer as this dictation's held audio (seq from 0); audio heard after joins it in order until the start commits.
// Fallback and Retry both end here; a failed start keeps the recording for Retry.
export async function replayMobileDictationToHost(
  run: MobileDictationRun,
  client: RpcClient,
  dictationId: string,
  generation: number
): Promise<void> {
  run.engine.current = { kind: 'host' }
  run.recording.current.replayInto(run.heldAudio.current)
  run.audioPhase.current = 'holding'
  try {
    await startMobileDictationOnHost(run, client, dictationId, generation, true)
  } catch (err) {
    concludeMobileDictationFailure(run, dictationId, err)
  }
}
