import { useMemo } from 'react'
import { speakOnDevice, stopSpeakingOnDevice } from './native-speech'

export type SpeechOutput = {
  canSpeak: boolean
  speak: (text: string) => Promise<boolean>
  stop: () => void
}

export function useSpeechOutput(): SpeechOutput {
  return useMemo(() => ({ canSpeak: true, speak: speakOnDevice, stop: stopSpeakingOnDevice }), [])
}
