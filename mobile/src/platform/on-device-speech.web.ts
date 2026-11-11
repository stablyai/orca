import { useLayoutEffect, useMemo, useRef } from 'react'
import type { DictationTerm } from '../../../src/shared/dictation-dictionary'
import { createDictationTextPipeline } from '../../../src/shared/dictation-text-pipeline'
import { useNativeVerbs, type NativeVerbs } from '../mobile-web-shell/bridge/use-native-verbs'
import type { OnDeviceSpeech } from './on-device-speech-contract'
import { onDeviceSpeechLocale } from './on-device-speech-locale'

const keepText = (text: string): string => text

// The phone's recognizer transcribes only the locale it started in, so that locale's language picks the fillers, as the host does for its model.
function phoneDictationTextCleaner(
  locale: string | null,
  removeFillerWords: boolean,
  dictationTerms: readonly DictationTerm[] | undefined
): (text: string) => string {
  const language = locale?.split('-')[0].toLowerCase()
  const clean = createDictationTextPipeline(
    language ? { language } : undefined,
    { removeFillerWords },
    dictationTerms
  )
  return clean ?? keepText
}

function createPageOnDeviceSpeech(
  verbs: NativeVerbs,
  textSettings: () => {
    removeFillerWords: boolean
    dictationTerms: readonly DictationTerm[] | undefined
  }
): OnDeviceSpeech {
  let clean = keepText
  return {
    status: () => verbs.speechStatus(onDeviceSpeechLocale()),
    start: async () => {
      const started = await verbs.speechStart(onDeviceSpeechLocale())
      const { removeFillerWords, dictationTerms } = textSettings()
      clean = phoneDictationTextCleaner(started.locale, removeFillerWords, dictationTerms)
      return started
    },
    read: async () => {
      const read = await verbs.speechRead()
      return { ...read, committed: clean(read.committed), tentative: clean(read.tentative) }
    },
    finish: async () => {
      const finished = await verbs.speechFinish()
      return finished.text === null ? finished : { ...finished, text: clean(finished.text) }
    },
    // Cancel has no reply anyone waits on; a shell that lost the session has nothing to stop.
    cancel: () => {
      void verbs.speechCancel().catch(() => undefined)
    }
  }
}

// Null on a shell without the verb, so dictation stays on the computer exactly as before.
// The computer's filler switch and dictionary for this worktree, read at each start.
export function useOnDeviceSpeech(
  removeFillerWords = true,
  dictationTerms?: readonly DictationTerm[]
): OnDeviceSpeech | null {
  const verbs = useNativeVerbs()
  const textSettingsRef = useRef({ removeFillerWords, dictationTerms })
  useLayoutEffect(() => {
    textSettingsRef.current = { removeFillerWords, dictationTerms }
  }, [removeFillerWords, dictationTerms])
  return useMemo(
    () =>
      verbs.canRecognizeSpeech
        ? createPageOnDeviceSpeech(verbs, () => textSettingsRef.current)
        : null,
    [verbs]
  )
}
