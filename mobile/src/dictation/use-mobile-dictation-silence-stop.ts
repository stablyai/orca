import { useEffect, useEffectEvent } from 'react'
import { watchDictationSilence } from '../../../src/shared/dictation-silence-stop'
import type { UseMobileDictationResult } from '../hooks/mobile-dictation-session-state'
import { nativeChatDictationCopy } from './mobile-session-native-chat-dictation-copy'

// A forgotten tap-mode mic keeps the screen awake; a finger holding the button is never forgotten.
export function useMobileDictationSilenceStop(
  dictation: Pick<UseMobileDictationResult, 'isRecording' | 'meter'>,
  dictationMode: string | undefined,
  stop: () => void,
  showToast: (message: string) => void
): void {
  const { meter } = dictation
  const watching = dictation.isRecording && dictationMode !== 'hold'
  const stopForSilence = useEffectEvent(() => {
    showToast(nativeChatDictationCopy.stoppedAfterSilence())
    stop()
  })

  useEffect(() => {
    if (!watching) {
      return
    }
    return watchDictationSilence(meter.lastSpeechAt, Date.now, () => stopForSilence())
  }, [meter, watching])
}
