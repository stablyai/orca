import { useCallback, useEffect, useRef, useState } from 'react'
import { useSpeechOutput } from '../platform/speech-output'

export function useMobileNativeChatReadAloud() {
  const speech = useSpeechOutput()
  const [speakingKey, setSpeakingKey] = useState<string | null>(null)
  const runRef = useRef(0)

  const stop = useCallback(() => {
    runRef.current += 1
    setSpeakingKey(null)
    speech.stop()
  }, [speech])

  const toggle = useCallback(
    (key: string, text: string) => {
      if (speakingKey === key) {
        stop()
        return
      }
      runRef.current += 1
      const run = runRef.current
      setSpeakingKey(key)
      // A replaced run still settles; only the current run may clear the state.
      void speech
        .speak(text)
        .catch(() => false)
        .then(() => {
          if (runRef.current === run) {
            setSpeakingKey(null)
          }
        })
    },
    [speakingKey, speech, stop]
  )

  useEffect(() => () => speech.stop(), [speech])

  return { canSpeak: speech.canSpeak, speakingKey, toggle, stop }
}
