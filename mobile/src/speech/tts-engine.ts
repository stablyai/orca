import * as Speech from 'expo-speech'
import { logSpeechEvent } from './speech-diagnostics'
import { voiceNativeModule, type VoiceNativeModule } from './voice-native-module'

export type UtteranceCallbacks = {
  onStart?: () => void
  onDone?: () => void
  onError?: (error: { message: string }) => void
}

const callbacks = new Map<string, UtteranceCallbacks>()
let sequence = 0
let subscribedTo: VoiceNativeModule | null = null
// The utterance being read, so a pause can ask the engine how far it got.
let speakingId: string | null = null
/**
 * `interrupted` (audio lost for good) and `held` (call, dictation) arrive with the engine stopped.
 * `noisy`: sound is about to move to the phone's speaker; `private-output`: headphones or car back.
 */
export type AudioEvent = 'interrupted' | 'held' | 'regained' | 'noisy' | 'private-output'

const AUDIO_EVENTS: readonly AudioEvent[] = [
  'interrupted',
  'held',
  'regained',
  'noisy',
  'private-output'
]

let onAudio: (event: AudioEvent, message: string | null) => void = () => undefined

export function onAudioEvent(handler: (event: AudioEvent, message: string | null) => void): void {
  onAudio = handler
  const native = voiceNativeModule()
  if (native !== null) {
    ensureSubscribed(native)
  }
}

function ensureSubscribed(native: VoiceNativeModule): void {
  if (subscribedTo === native) {
    return
  }
  subscribedTo = native
  native.addListener('onSpeech', ({ event, id, message }) => {
    const audioEvent = AUDIO_EVENTS.find((known) => known === event)
    if (audioEvent !== undefined) {
      if (audioEvent === 'interrupted' || audioEvent === 'held') {
        callbacks.clear()
      }
      onAudio(audioEvent, message)
      return
    }
    if (event === 'waiting') {
      logSpeechEvent('waiting for the microphone to be free')
      return
    }
    if (event !== 'start' && id === speakingId) {
      speakingId = null
    }
    const handlers = callbacks.get(id)
    if (!handlers) {
      return
    }
    if (event === 'start') {
      speakingId = id
      handlers.onStart?.()
      return
    }
    callbacks.delete(id)
    if (event === 'done') {
      handlers.onDone?.()
    } else {
      handlers.onError?.({ message: message ?? 'text-to-speech failed' })
    }
  })
}

/** Hands one utterance to the module; its progress comes back as `onSpeech` events by id. */
function sendToNative(
  native: VoiceNativeModule,
  handlers: UtteranceCallbacks,
  send: (id: string) => boolean,
  failure: string
): void {
  ensureSubscribed(native)
  sequence += 1
  const id = `utterance-${sequence}`
  speakingId = null
  callbacks.set(id, handlers)
  if (!send(id)) {
    callbacks.delete(id)
    handlers.onError?.({ message: failure })
  }
}

/** `language`: read with a voice for that language instead of the reading voice. */
export function speakUtterance(
  text: string,
  handlers: UtteranceCallbacks,
  language: string | null = null
): void {
  // Why: the native module voices speech as navigation guidance with audio focus, so music ducks
  // and car head units play it; expo-speech's default attributes stayed silent there.
  const native = voiceNativeModule()
  if (native === null) {
    Speech.speak(text, { ...handlers, language: language ?? undefined })
    return
  }
  sendToNative(
    native,
    handlers,
    (id) => native.speak(id, text, language),
    'text-to-speech is not available'
  )
}

export function playChime(handlers: UtteranceCallbacks): void {
  const native = voiceNativeModule()
  if (native === null) {
    handlers.onDone?.()
    return
  }
  sendToNative(native, handlers, (id) => native.chime(id), 'the chime could not play')
}

/** How much of the utterance being read was spoken: up to the start of its current word. */
export function spokenOffset(): number {
  const native = voiceNativeModule()
  return native !== null && speakingId !== null ? native.spokenOffset(speakingId) : 0
}

export function stopUtterances(): void {
  const native = voiceNativeModule()
  if (native === null) {
    void Speech.stop()
    return
  }
  // Stopped utterances report no `done`, and the speaker has already moved on without them.
  callbacks.clear()
  native.stopSpeech()
}
