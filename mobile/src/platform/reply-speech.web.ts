import { useMemo } from 'react'
import { SPEECH_MAX_MARKDOWN_CHARS } from '../mobile-web-shell/bridge/bridge-speech-verbs'
import { useNativeVerbs } from '../mobile-web-shell/bridge/use-native-verbs'
import type { ReplySpeech } from './reply-speech'

// Android's WebView lacks speechSynthesis, so the shell speaks. A very long reply is read from its
// start rather than refused; failures are swallowed since an unread reply is not worth a dialog.
export function useReplySpeech(): ReplySpeech {
  const verbs = useNativeVerbs()
  return useMemo(
    () => ({
      canSpeak: verbs.canSpeak,
      speak: (id, markdown) => {
        void verbs.speak(id, markdown.slice(0, SPEECH_MAX_MARKDOWN_CHARS)).catch(() => undefined)
      }
    }),
    [verbs]
  )
}
