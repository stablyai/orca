import type { RefObject } from 'react'
import { dictationSessionErrorMessage } from '../dictation/mobile-dictation-setup'
import type { DictationCapture } from '../platform/dictation-capture-contract'
import type { OnDeviceSpeech } from '../platform/on-device-speech-contract'
import { openMobileDictationCapture } from './mobile-dictation-capture-open'
import { createMobileDictationId, type DictationStatus } from './mobile-dictation-session-state'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type {
  MobileDictationAudioPhase,
  MobileDictationTranscriptSoFar
} from './mobile-dictation-audio-chunk'
import { cancelDesktopDictation } from './mobile-dictation-desktop-start'
import {
  chooseMobileDictationRoute,
  phoneDictationBusyMessage,
  phoneDictationFailedMessage,
  phoneDictationUnavailableMessage,
  readOnDeviceSpeech,
  startOnDeviceSpeech,
  type MobileDictationEngine,
  type MobileDictationRoute
} from './mobile-dictation-device-engine'
import type { MobileDictationPendingAudioBudget } from './mobile-dictation-pending-audio-budget'
import type { MobileDictationHeldAudio } from './mobile-dictation-held-audio'
import type { MobileDictationRecording } from './mobile-dictation-recording'
import {
  replayMobileDictationToHost,
  startMobileDictationOnHost
} from './mobile-dictation-host-start'
import type { ShowMobileDictationEngine } from './mobile-dictation-engine-shown'

// What the engines share with useMobileDictation: its refs (read at call time) and its state transitions.
export type MobileDictationRun = {
  readonly status: RefObject<DictationStatus>
  readonly activeId: RefObject<string | null>
  readonly client: RefObject<RpcClient | null>
  readonly speech: RefObject<OnDeviceSpeech | null>
  readonly engine: RefObject<MobileDictationEngine>
  readonly enabled: RefObject<boolean>
  readonly generation: RefObject<number>
  readonly stopWhenStarted: RefObject<boolean>
  readonly audioPhase: RefObject<MobileDictationAudioPhase>
  readonly pendingChunks: RefObject<Set<Promise<void>>>
  readonly pendingAudioBudget: RefObject<MobileDictationPendingAudioBudget>
  readonly heldAudio: RefObject<MobileDictationHeldAudio>
  readonly recording: RefObject<MobileDictationRecording>
  readonly sendHeldAudio: RefObject<() => void>
  readonly finish: RefObject<(emptyTranscriptMessage: string) => Promise<void>>
  readonly onTranscript: RefObject<(text: string) => void>
  readonly onAudioLimitReached: RefObject<(() => void) | undefined>
  readonly keptTranscript: MobileDictationTranscriptSoFar
  // keepText: leave the words so far on screen (recording, finishing, or a failure kept for Retry).
  readonly applyStatus: (next: DictationStatus, keepText?: boolean) => void
  readonly showEngine: ShowMobileDictationEngine
  readonly closeDictationAudio: () => void
  // kept: the recording stays for Retry, the words so far stay shown, and nothing is inserted yet.
  readonly reportError: (err: unknown, kept?: boolean) => void
  readonly failActiveDictation: (dictationId: string, err: unknown) => void
}

// Stop whichever engine heard this dictation; only a computer session needs a cancel on the wire.
export function releaseMobileDictationEngine(
  run: Pick<MobileDictationRun, 'engine' | 'speech'>,
  client: RpcClient | null,
  dictationId: string | null
): Promise<void> {
  const engine = run.engine.current
  run.engine.current = { kind: 'host' }
  if (engine.kind === 'device') {
    engine.stopReading()
    run.speech.current?.cancel()
    return Promise.resolve()
  }
  return client && dictationId ? cancelDesktopDictation(client, dictationId) : Promise.resolve()
}

// Close the dictation with its final text; both engines end here.
export function settleMobileDictation(
  run: MobileDictationRun,
  text: string,
  emptyTranscriptMessage: string
): void {
  run.activeId.current = null
  run.engine.current = { kind: 'host' }
  run.audioPhase.current = 'closed'
  run.heldAudio.current.clear()
  run.recording.current.clear()
  run.pendingChunks.current.clear()
  run.pendingAudioBudget.current.reset()
  run.applyStatus('idle')
  if (text) {
    run.onTranscript.current(text)
  } else {
    run.reportError(new Error(emptyTranscriptMessage))
  }
}

// The phone's recognizer failed: replay the recording to the computer, as a start's held audio (seq from 0), and carry on there.
export async function fallBackMobileDictationToHost(
  run: MobileDictationRun,
  dictationId: string,
  finishing: boolean
): Promise<void> {
  const engine = run.engine.current
  if (engine.kind !== 'device' || run.activeId.current !== dictationId) {
    return
  }
  engine.stopReading()
  run.speech.current?.cancel()
  const client = run.client.current
  // Offline there is no computer to replay to; fail now with the phone's text rather than wait out the reconnect grace.
  if (
    !engine.fallback ||
    !client ||
    client.getState() !== 'connected' ||
    !run.recording.current.complete
  ) {
    run.failActiveDictation(dictationId, new Error(phoneDictationFailedMessage()))
    return
  }
  run.showEngine('computer', true)
  // A stop that began while the phone was still live is already processing; the computer must finish it too.
  run.stopWhenStarted.current = finishing || run.status.current === 'processing'
  await replayMobileDictationToHost(run, client, dictationId, run.generation.current)
}

// Pick the engine before the mic opens, and arm the phone's recognizer so it hears the first word.
// Null: stale, or the phone failed with no fallback allowed (thrown). Device: armed. Host: use the computer.
export async function armMobileDictationEngine(
  run: MobileDictationRun,
  isCurrent: () => boolean
): Promise<Exclude<MobileDictationRoute, { kind: 'phone-unavailable' }> | null> {
  const speech = run.speech.current
  const route = await chooseMobileDictationRoute(speech)
  if (!isCurrent()) {
    return null
  }
  if (route.kind === 'phone-unavailable') {
    throw new Error(route.busy ? phoneDictationBusyMessage() : phoneDictationUnavailableMessage())
  }
  if (route.kind === 'host' || speech === null) {
    return { kind: 'host' }
  }
  const refused = await startOnDeviceSpeech(speech)
  if (!isCurrent()) {
    if (refused === null) {
      speech.cancel()
    }
    return null
  }
  if (refused === null) {
    return route
  }
  if (!route.fallback) {
    throw new Error(
      refused === 'busy' ? phoneDictationBusyMessage() : phoneDictationFailedMessage()
    )
  }
  return { kind: 'host' }
}

// Recording started on the phone: no computer round trip, text read on the drain tick, audio held for a replay.
export function commitMobileDictationOnDevice(
  run: MobileDictationRun,
  dictationId: string,
  fallback: boolean
): void {
  const speech = run.speech.current
  if (speech === null) {
    return
  }
  run.engine.current = {
    kind: 'device',
    fallback,
    stopReading: readOnDeviceSpeech(
      speech,
      (text) => {
        if (run.activeId.current === dictationId) {
          // Lowest rank: once a fallback replays the audio, the computer's numbered text replaces the phone's.
          run.keptTranscript.note(dictationId, text, Number.NEGATIVE_INFINITY)
        }
      },
      () => void fallBackMobileDictationToHost(run, dictationId, false)
    )
  }
  // The recording keeps the phone's audio for a replay; nothing goes to the computer while the phone hears it.
  run.audioPhase.current = 'closed'
  run.heldAudio.current.clear()
  run.applyStatus('recording')
  run.showEngine('phone')
  if (run.stopWhenStarted.current) {
    void run.finish.current(dictationSessionErrorMessage('no-speech'))
  }
}

// The phone's final text, or a replay to the computer when the phone could not give one.
export async function finishMobileDictationOnDevice(
  run: MobileDictationRun,
  engine: Extract<MobileDictationEngine, { kind: 'device' }>,
  dictationId: string,
  emptyTranscriptMessage: string,
  isCurrent: () => boolean
): Promise<void> {
  engine.stopReading()
  const speech = run.speech.current
  const finished = speech === null ? null : await speech.finish().catch(() => null)
  if (!isCurrent()) {
    return
  }
  if (finished === null || finished.failure !== null || finished.text === null) {
    await fallBackMobileDictationToHost(run, dictationId, true)
    return
  }
  settleMobileDictation(run, finished.text.trim(), emptyTranscriptMessage)
}

const HOST_ENGINE = { kind: 'host' } as const

// Pick the engine, open the mic from the tap, then start the phone's recognizer or the computer's session.
export async function startMobileDictation(
  run: MobileDictationRun,
  capture: DictationCapture
): Promise<void> {
  const client = run.client.current
  const generation = run.generation.current + 1
  run.generation.current = generation
  run.stopWhenStarted.current = false
  run.applyStatus('starting')
  const isCurrentGeneration = () => run.generation.current === generation
  // Without a phone recognizer, start exactly as before: no extra turn before the mic opens.
  const engine =
    run.speech.current === null
      ? HOST_ENGINE
      : await armMobileDictationEngine(run, isCurrentGeneration).catch((err: unknown) => {
          run.applyStatus('idle')
          throw err
        })
  if (engine === null || (engine.kind === 'host' && !client)) {
    if (engine !== null) {
      run.applyStatus('idle')
    }
    return
  }
  // A phone recognizer armed for a mic that never opened must not keep listening.
  const disarm = () => {
    if (engine.kind === 'device') {
      run.speech.current?.cancel()
    }
  }
  const recording = await openMobileDictationCapture({
    capture,
    isCurrent: () => isCurrentGeneration() && run.enabled.current,
    isCurrentGeneration,
    setIdle: () => run.applyStatus('idle'),
    // Record from the tap: speech during the host's engine build and round trip is held, not lost; a phone dictation holds it all for a replay.
    hold: () => {
      run.audioPhase.current = 'holding'
    },
    close: run.closeDictationAudio
  }).catch((err: unknown) => {
    disarm()
    throw err
  })
  if (!recording) {
    disarm()
    return
  }
  const dictationId = createMobileDictationId()
  run.activeId.current = dictationId
  if (engine.kind === 'device') {
    commitMobileDictationOnDevice(run, dictationId, engine.fallback)
  } else if (client) {
    await startMobileDictationOnHost(run, client, dictationId, generation)
  }
}
