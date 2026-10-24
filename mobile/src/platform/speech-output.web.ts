import { useMemo } from 'react'
import { useNativeVerbs } from '../mobile-web-shell/bridge/use-native-verbs'
import type { SpeechOutput } from './speech-output'

export type { SpeechOutput } from './speech-output'

export function useSpeechOutput(): SpeechOutput {
  const verbs = useNativeVerbs()
  return useMemo(
    () => ({
      canSpeak: verbs.canSpeak,
      speak: verbs.speak,
      stop: () => void verbs.stopSpeaking().catch(() => undefined)
    }),
    [verbs]
  )
}
