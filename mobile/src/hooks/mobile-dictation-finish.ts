import { rpcPayloadMember } from '../transport/rpc/rpc-reader-payload'
import type { DictationCapture } from '../platform/dictation-capture-contract'
import { isCurrentMobileDictationFinish } from './mobile-dictation-session-state'
import { finishDesktopDictation } from './mobile-dictation-desktop-start'
import {
  finishMobileDictationOnDevice,
  settleMobileDictation,
  type MobileDictationRun
} from './mobile-dictation-engine-run'

// Stop listening and settle the dictation with its final text, from whichever engine heard it.
export async function finishMobileDictation(
  run: MobileDictationRun,
  capture: Pick<DictationCapture, 'end'>,
  emptyTranscriptMessage: string
): Promise<void> {
  const client = run.client.current
  const dictationId = run.activeId.current
  const engine = run.engine.current
  if (!dictationId || (engine.kind === 'host' && !client)) {
    return
  }
  // A replay's host start is still pending: finish once it commits and the kept audio has gone.
  if (engine.kind === 'host' && run.audioPhase.current === 'holding') {
    run.stopWhenStarted.current = true
    if (run.status.current === 'recording') {
      run.applyStatus('processing')
      // Stop listening now; the tail joins the held audio the replay sends.
      void capture.end()
    }
    return
  }

  const generation = run.generation.current + 1
  run.generation.current = generation
  run.applyStatus('processing')
  const isCurrent = () =>
    isCurrentMobileDictationFinish(
      run.generation.current,
      generation,
      run.enabled.current,
      run.activeId.current,
      dictationId
    )
  try {
    // Keep shutdown inside try for finally cleanup; accept its tail chunks and snapshot pending sends only after end settles, or finish can overtake the last audio.
    await capture.end()
    if (engine.kind === 'device') {
      await finishMobileDictationOnDevice(
        run,
        engine,
        dictationId,
        emptyTranscriptMessage,
        isCurrent
      )
      return
    }
    run.audioPhase.current = 'closed'
    await Promise.allSettled(Array.from(run.pendingChunks.current))
    if (!isCurrent() || !client) {
      return
    }
    const sentSeconds = run.pendingAudioBudget.current.sentAudioSeconds
    const finished = await finishDesktopDictation(client, dictationId, sentSeconds)
    if (!isCurrent()) {
      return
    }
    const transcript = rpcPayloadMember(finished, 'text')
    settleMobileDictation(
      run,
      typeof transcript === 'string' ? transcript.trim() : '',
      emptyTranscriptMessage
    )
  } catch (err) {
    run.failActiveDictation(dictationId, err)
  }
}
