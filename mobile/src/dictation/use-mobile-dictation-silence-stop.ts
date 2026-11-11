import { useEffect, useEffectEvent } from 'react'
import {
  watchDictationSilence,
  type StopAfterSilenceSeconds
} from '../../../src/shared/dictation-silence-stop'
import type { UseMobileDictationResult } from '../hooks/mobile-dictation-session-state'
import { nativeChatDictationCopy } from './mobile-session-native-chat-dictation-copy'

// A forgotten tap-mode mic keeps the screen awake; a finger holding the button is never forgotten.
export function useMobileDictationSilenceStop(
  dictation: Pick<UseMobileDictationResult, 'isRecording' | 'meter'>,
  dictationMode: string | undefined,
  silenceSeconds: StopAfterSilenceSeconds,
  stop: () => void,
  showToast: (message: string) => void
): void {
  const { meter } = dictation
  const watching = dictation.isRecording && dictationMode !== 'hold' && silenceSeconds !== null
  const stopForSilence = useEffectEvent(() => {
    showToast(nativeChatDictationCopy.stoppedAfterSilence(silenceSeconds ?? 0))
    stop()
  })

  useEffect(() => {
    if (!watching || silenceSeconds === null) {
      return
    }
    return watchDictationSilence(meter.lastSpeechAt, Date.now, silenceSeconds * 1000, () =>
      stopForSilence()
    )
  }, [meter, watching, silenceSeconds])
}
