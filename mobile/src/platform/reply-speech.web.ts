import { useMemo } from 'react'
import { SPEECH_MAX_MARKDOWN_CHARS } from '../mobile-web-shell/bridge/bridge-speech-verbs'
import { useNativeVerbs } from '../mobile-web-shell/bridge/use-native-verbs'
import type { ReplySpeech } from './reply-speech'

// Android's WebView lacks speechSynthesis, so the shell speaks. A very long reply is read from its
// start rather than refused; failures are swallowed since an unread reply is not worth a dialog.
const FENCE = /^[ \t]*```/gm
const CLOSING_FENCE = '\n```'

// Why: a cut inside a code block would leave its fence open, and the code would be read aloud.
export function limitedMarkdown(markdown: string): string {
  if (markdown.length <= SPEECH_MAX_MARKDOWN_CHARS) {
    return markdown
  }
  const cut = markdown.slice(0, SPEECH_MAX_MARKDOWN_CHARS - CLOSING_FENCE.length)
  const fences = cut.match(FENCE)?.length ?? 0
  return fences % 2 === 1 ? cut + CLOSING_FENCE : cut
}

export function useReplySpeech(): ReplySpeech {
  const verbs = useNativeVerbs()
  return useMemo(
    () => ({
      canSpeak: verbs.canSpeak,
      speak: (id, markdown) => {
        void verbs.speak(id, limitedMarkdown(markdown)).catch(() => undefined)
      }
    }),
    [verbs]
  )
}
