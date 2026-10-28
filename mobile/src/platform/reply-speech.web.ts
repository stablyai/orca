import { useMemo } from 'react'
import { usePageBridgeClient } from '../transport/client-context.web'
import type { ReplySpeech } from './reply-speech'

const SPEECH_VERB = 'native.speech.control' as const

// Why: Android's WebView lacks speechSynthesis, so the shell speaks; a shell without the grant
// gets no Read button, and failures are swallowed since an unread reply is not worth a dialog.
export function useReplySpeech(): ReplySpeech {
  const client = usePageBridgeClient()
  return useMemo(() => {
    const canSpeak = client.getShellSession()?.grants.native.includes(SPEECH_VERB) === true
    const send = (params: unknown) => {
      if (canSpeak) {
        void client.callNativeVerb(SPEECH_VERB, params).catch(() => undefined)
      }
    }
    return {
      canSpeak,
      speak: (id, markdown) => send({ action: 'speak', id, markdown }),
      stop: () => send({ action: 'stop' })
    }
  }, [client])
}
