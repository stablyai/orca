import { useLayoutEffect, useMemo, useRef } from 'react'
import { createDictationTextPipeline } from '../../../src/shared/dictation-text-pipeline'
import { useNativeVerbs, type NativeVerbs } from '../mobile-web-shell/bridge/use-native-verbs'
import type { OnDeviceSpeech } from './on-device-speech-contract'
import { onDeviceSpeechLocale } from './on-device-speech-locale'

const keepText = (text: string): string => text

// The phone's recognizer transcribes only the locale it started in, so that locale's language picks the fillers, as the host does for its model.
function phoneDictationTextCleaner(
  locale: string | null,
  removeFillerWords: boolean
): (text: string) => string {
  const language = locale?.split('-')[0].toLowerCase()
  const clean = createDictationTextPipeline(language ? { language } : undefined, {
    removeFillerWords
  })
  return clean ?? keepText
}

function createPageOnDeviceSpeech(
  verbs: NativeVerbs,
  removeFillerWords: () => boolean
): OnDeviceSpeech {
  let clean = keepText
  return {
    status: () => verbs.speechStatus(onDeviceSpeechLocale()),
    start: async () => {
      const started = await verbs.speechStart(onDeviceSpeechLocale())
      clean = phoneDictationTextCleaner(started.locale, removeFillerWords())
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
// removeFillerWords is the computer's switch, read at each start.
export function useOnDeviceSpeech(removeFillerWords = true): OnDeviceSpeech | null {
  const verbs = useNativeVerbs()
  const removeFillerWordsRef = useRef(removeFillerWords)
  useLayoutEffect(() => {
    removeFillerWordsRef.current = removeFillerWords
  }, [removeFillerWords])
  return useMemo(
    () =>
      verbs.canRecognizeSpeech
        ? createPageOnDeviceSpeech(verbs, () => removeFillerWordsRef.current)
        : null,
    [verbs]
  )
}
