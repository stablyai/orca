import { useCallback } from 'react'
import { triggerError } from '../platform/haptics'
import { useClipboardWriter } from '../platform/clipboard'
import {
  dictationFailureMessage,
  isDictationSetupRequiredError
} from '../dictation/mobile-dictation-setup'
import { nativeChatDictationCopy } from './mobile-session-native-chat-dictation-copy'
import type { MobileSessionFeedbackCapabilitiesModel } from './use-mobile-session-feedback-capabilities'

export function useMobileNativeChatDictationFailure({
  setShowDictationSetup,
  showToast
}: Pick<MobileSessionFeedbackCapabilitiesModel, 'setShowDictationSetup' | 'showToast'>) {
  // Share dictation error handling for start rejection and live errors so disabled host setup always opens the setup sheet.
  const reportDictationFailure = useCallback(
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      if (isDictationSetupRequiredError(message)) {
        setShowDictationSetup(true)
        return
      }
      triggerError()
      showToast(dictationFailureMessage(message))
    },
    [setShowDictationSetup, showToast]
  )

  const clipboard = useClipboardWriter()
  // A transcript its target refused must not vanish: keep it on the clipboard and say so.
  const keepUndeliveredDictation = (text: string) => {
    triggerError()
    void clipboard.writeText(text).then(
      () => showToast(nativeChatDictationCopy.insertFailedCopied()),
      () => showToast(nativeChatDictationCopy.insertFailed())
    )
  }

  return { reportDictationFailure, keepUndeliveredDictation }
}
