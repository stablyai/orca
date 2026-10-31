import { useEffect, useEffectEvent } from 'react'
import type { UseMobileDictationResult } from '../hooks/mobile-dictation-session-state'
import { nativeChatDictationCopy } from './mobile-session-native-chat-dictation-copy'

const DICTATION_SILENCE_STOP_MS = 60_000

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
    // Wall clock, so a stalled audio stream still counts as silence.
    const recordingAt = Date.now()
    let timer: ReturnType<typeof setTimeout>
    const check = () => {
      const lastSpeechAt = Math.max(recordingAt, meter.lastSpeechAt())
      const remainingMs = lastSpeechAt + DICTATION_SILENCE_STOP_MS - Date.now()
      if (remainingMs > 0) {
        timer = setTimeout(check, remainingMs)
      } else {
        stopForSilence()
      }
    }
    check()
    return () => clearTimeout(timer)
  }, [meter, watching])
}
