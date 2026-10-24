import * as Speech from 'expo-speech'
import { speechSpeakParamsSchema } from '../mobile-web-shell/bridge/bridge-native-verbs'
import { nativeChatSpeechChunks } from '../session/mobile-native-chat-speech-text'

let settleCurrent: ((finished: boolean) => void) | null = null

export function stopSpeakingOnDevice(): void {
  settleCurrent?.(false)
  settleCurrent = null
  void Speech.stop()
}

/** Settles when the speech ends: true when it ran to the end, false when stopped or replaced. */
export function speakOnDevice(text: string): Promise<boolean> {
  stopSpeakingOnDevice()
  // Android refuses one utterance over 4,000 characters, so a long reply is queued in parts.
  const chunks = nativeChatSpeechChunks(text)
  if (chunks.length === 0) {
    return Promise.resolve(false)
  }
  return new Promise((resolve) => {
    const settle = (finished: boolean) => {
      if (settleCurrent === settle) {
        settleCurrent = null
      }
      resolve(finished)
    }
    settleCurrent = settle
    chunks.forEach((chunk, index) => {
      Speech.speak(
        chunk,
        index === chunks.length - 1
          ? {
              onDone: () => settle(true),
              onStopped: () => settle(false),
              onError: () => settle(false)
            }
          : { onError: () => settle(false) }
      )
    })
  })
}

export async function serveNativeSpeechVerb(params: unknown): Promise<unknown> {
  const { text } = speechSpeakParamsSchema.parse(params)
  if (text === '') {
    stopSpeakingOnDevice()
    return { finished: false }
  }
  return { finished: await speakOnDevice(text) }
}
