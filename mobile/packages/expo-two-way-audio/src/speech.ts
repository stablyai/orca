import ExpoTwoWayAudioModule from './ExpoTwoWayAudioModule'

// On-device speech recognition contract. iOS and Android implement these functions and events on the
// ExpoTwoWayAudio module; JS feature-detects them because a shell built before them answers 'unsupported'.
//
// Audio: the shell feeds the recognizer the same 16-bit little-endian mono PCM the microphone delivers in
// onMicrophoneData, through speechFeed. The recognizer never opens the microphone itself, so capture,
// interruptions and the screen lock stay where they are.
//
// One session at a time. speechStart while a session is live cancels the old one first.

export const SPEECH_AVAILABILITY_STATUSES = ['ready', 'needs-download', 'unsupported'] as const

export type SpeechAvailabilityStatus = (typeof SPEECH_AVAILABILITY_STATUSES)[number]

export type SpeechAvailability = {
  status: SpeechAvailabilityStatus
  // The supported locale the recognizer would use for the requested one (e.g. 'en' -> 'en-US'); null when unsupported.
  locale: string | null
}

// Why a start or a live session failed. Every code sends the page to the computer, so keep them coarse.
export const SPEECH_FAILURE_CODES = [
  'unsupported',
  'needs-download',
  'permission-denied',
  'busy',
  'failed'
] as const

export type SpeechFailureCode = (typeof SPEECH_FAILURE_CODES)[number]

export type SpeechStartResult =
  | { started: true; locale: string }
  | { started: false; reason: SpeechFailureCode }

// committed is the whole final text so far, never a delta; tentative is the current unstable tail after it.
// revision only rises over the module's lifetime, across sessions too, so a reader can drop a stale or previous-session event.
export type SpeechTextEvent = { revision: number; committed: string; tentative: string }

export type SpeechErrorEvent = { code: SpeechFailureCode }

// fraction is 0..1 for the locale's assets; a download that ends emits no final event, its promise settles instead.
export type SpeechDownloadProgressEvent = { locale: string; fraction: number }

type SpeechNativeModule = {
  // Never prompts and never downloads. Must be cheap: called before every dictation.
  // Rejects with code 'busy' when the OS speech service didn't answer in time; asking again later is safe.
  speechAvailability?: (locale: string) => Promise<SpeechAvailability>
  // Installs the assets for locale; resolves true when ready, false when it failed or isn't possible.
  speechDownload?: (locale: string) => Promise<boolean>
  // Arms a session. Prompts for any speech permission the OS needs (the microphone prompt is not its job).
  // Resolve quickly: audio fed before the recognizer is warm must be queued natively, never dropped.
  speechStart?: (locale: string, sampleRate: number) => Promise<SpeechStartResult>
  // Synchronous and never throws. Ignored with no live session.
  speechFeed?: (pcm: Uint8Array) => void
  // Ends input, waits for every fed sample to be recognized, resolves the whole final text and ends the session.
  // Rejects (or emits onSpeechError) when recognition failed; the page then sends the kept audio to the computer.
  speechFinish?: () => Promise<string>
  // Ends the session and drops its text. Synchronous, never throws, safe with no session.
  speechCancel?: () => void
}

const speech: SpeechNativeModule = ExpoTwoWayAudioModule

// A shell from before this contract lacks every function; partial builds are treated the same way.
export function hasNativeSpeech(): boolean {
  return (
    typeof speech.speechAvailability === 'function' &&
    typeof speech.speechDownload === 'function' &&
    typeof speech.speechStart === 'function' &&
    typeof speech.speechFeed === 'function' &&
    typeof speech.speechFinish === 'function' &&
    typeof speech.speechCancel === 'function'
  )
}

export async function speechAvailability(locale: string): Promise<SpeechAvailability> {
  if (!hasNativeSpeech() || !speech.speechAvailability) {
    return { status: 'unsupported', locale: null }
  }
  return speech.speechAvailability(locale)
}

export async function speechDownload(locale: string): Promise<boolean> {
  return hasNativeSpeech() && speech.speechDownload ? speech.speechDownload(locale) : false
}

export async function speechStart(locale: string, sampleRate: number): Promise<SpeechStartResult> {
  if (!hasNativeSpeech() || !speech.speechStart) {
    return { started: false, reason: 'unsupported' }
  }
  return speech.speechStart(locale, sampleRate)
}

export function speechFeed(pcm: Uint8Array): void {
  speech.speechFeed?.(pcm)
}

export async function speechFinish(): Promise<string> {
  if (!speech.speechFinish) {
    throw new Error('on-device speech is not available in this build')
  }
  return speech.speechFinish()
}

export function speechCancel(): void {
  speech.speechCancel?.()
}
