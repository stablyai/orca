import { useCallback, useRef, useState } from 'react'
import { useOnDeviceSpeech } from '../platform/on-device-speech'
import { chooseMobileDictationRoute } from './mobile-dictation-device-engine'

// Whether a tap now would dictate on the phone itself. The ref answers inside a tap; the state re-renders the mic.
export function usePhoneDictationReady() {
  const speech = useOnDeviceSpeech()
  const [ready, setReady] = useState(false)
  const readyRef = useRef(false)
  const readRef = useRef(0)
  const refresh = useCallback(async () => {
    const read = ++readRef.current
    const route = await chooseMobileDictationRoute(speech)
    if (read === readRef.current) {
      readyRef.current = route.kind === 'device'
      setReady(readyRef.current)
    }
  }, [speech])
  return { ready, readyRef, refresh }
}
