import { useMemo } from 'react'
import { useNativeVerbs, type NativeVerbs } from '../mobile-web-shell/bridge/use-native-verbs'
import type { OnDeviceSpeech } from './on-device-speech-contract'
import { onDeviceSpeechLocale } from './on-device-speech-locale'

function createPageOnDeviceSpeech(verbs: NativeVerbs): OnDeviceSpeech {
  return {
    status: () => verbs.speechStatus(onDeviceSpeechLocale()),
    start: () => verbs.speechStart(onDeviceSpeechLocale()),
    read: verbs.speechRead,
    finish: verbs.speechFinish,
    // Cancel has no reply anyone waits on; a shell that lost the session has nothing to stop.
    cancel: () => {
      void verbs.speechCancel().catch(() => undefined)
    }
  }
}

// Null on a shell without the verb, so dictation stays on the computer exactly as before.
export function useOnDeviceSpeech(): OnDeviceSpeech | null {
  const verbs = useNativeVerbs()
  return useMemo(() => (verbs.canRecognizeSpeech ? createPageOnDeviceSpeech(verbs) : null), [verbs])
}
