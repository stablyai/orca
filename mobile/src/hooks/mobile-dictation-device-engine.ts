import type {
  BridgeSpeechFailure,
  BridgeSpeechRead
} from '../mobile-web-shell/bridge/bridge-speech-verbs'
import type { OnDeviceSpeech } from '../platform/speech/on-device-speech-contract'
import { DICTATION_CAPTURE_DRAIN_INTERVAL_MS } from '../platform/audio-capture/dictation-capture-contract'
import { translate } from '../i18n/mobile-i18n'

// Which engine hears this dictation. fallback: a failed phone session may replay its audio to the computer (Automatic only).
export type MobileDictationEngine =
  | { kind: 'host' }
  | { kind: 'device'; fallback: boolean; stopReading: () => void }

export type MobileDictationRoute =
  | { kind: 'host' }
  | { kind: 'device'; fallback: boolean }
  | { kind: 'phone-unavailable'; busy: boolean }

// Automatic uses the phone when it is ready; This phone never sends audio to the computer; Computer is today's path.
export async function chooseMobileDictationRoute(
  speech: OnDeviceSpeech | null
): Promise<MobileDictationRoute> {
  if (speech === null) {
    return { kind: 'host' }
  }
  let status
  try {
    status = await speech.status()
  } catch {
    return { kind: 'host' }
  }
  if (status.preference === 'computer') {
    return { kind: 'host' }
  }
  const fallback = status.preference === 'automatic'
  if (status.status === 'ready') {
    return { kind: 'device', fallback }
  }
  // Busy is never remembered: Automatic uses the computer this once and the next dictation asks again.
  return fallback ? { kind: 'host' } : { kind: 'phone-unavailable', busy: status.status === 'busy' }
}

// Arms the phone's recognizer; null means it refused or failed, and the caller decides between the computer and an error.
export async function startOnDeviceSpeech(
  speech: OnDeviceSpeech
): Promise<BridgeSpeechFailure | null> {
  try {
    const started = await speech.start()
    return started.started ? null : (started.reason ?? 'failed')
  } catch {
    return 'failed'
  }
}

function onDeviceTranscriptSoFar(read: Pick<BridgeSpeechRead, 'committed' | 'tentative'>) {
  const committed = read.committed.trim()
  const tentative = read.tentative.trim()
  return committed && tentative ? `${committed} ${tentative}` : committed || tentative
}

// The bridge has no push lane, so poll at the audio drain's pace, one read in flight at a time. A failure stops polling and is reported once.
export function readOnDeviceSpeech(
  speech: OnDeviceSpeech,
  onText: (text: string) => void,
  onFailure: (failure: BridgeSpeechFailure) => void,
  intervalMs: number = DICTATION_CAPTURE_DRAIN_INTERVAL_MS
): () => void {
  let revision = -1
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const stop = () => {
    stopped = true
    if (timer !== null) {
      clearTimeout(timer)
    }
  }
  const fail = (failure: BridgeSpeechFailure) => {
    if (!stopped) {
      stop()
      onFailure(failure)
    }
  }
  const tick = () => {
    void speech.read().then(
      (read) => {
        if (stopped) {
          return
        }
        if (read.failure !== null) {
          fail(read.failure)
          return
        }
        if (read.revision > revision) {
          revision = read.revision
          onText(onDeviceTranscriptSoFar(read))
        }
        timer = setTimeout(tick, intervalMs)
      },
      () => fail('failed')
    )
  }
  timer = setTimeout(tick, intervalMs)
  return stop
}

export function phoneDictationUnavailableMessage(): string {
  return translate(
    'hooks.useMobileDictation.phoneUnavailable',
    'Dictation on this phone isn’t ready. Download it in Voice settings, or choose Automatic.'
  )
}

export function phoneDictationBusyMessage(): string {
  return translate(
    'hooks.useMobileDictation.phoneBusy',
    'Dictation on this phone is still starting. Try again in a moment.'
  )
}

export function phoneDictationFailedMessage(): string {
  return translate(
    'hooks.useMobileDictation.phoneFailed',
    'Dictation on this phone stopped working. Try again.'
  )
}
