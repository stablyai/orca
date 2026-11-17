// Text the phone recognizes itself gets the computer's filler removal, in the language the recognizer started in.
import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { OnDeviceSpeech } from './on-device-speech-contract'

vi.mock('../../mobile-web-shell/bridge/use-native-verbs', () => {
  const verbs = {
    canRecognizeSpeech: true,
    speechStatus: async () => ({ status: 'ready', locale: 'de-DE', preference: 'automatic' }),
    speechStart: async () => ({ started: true, locale: 'de-DE', reason: null }),
    speechRead: async () => ({
      revision: 1,
      committed: 'Äh, das ist um fünf Uhr.',
      tentative: 'ähm',
      failure: null
    }),
    speechFinish: async () => ({
      text: 'Äh, das ist, ähm, um fünf Uhr fertig.',
      failure: null
    }),
    speechCancel: async () => ({})
  }
  return { useNativeVerbs: () => verbs }
})

vi.mock('./on-device-speech-locale', () => ({ onDeviceSpeechLocale: () => 'de-DE' }))

import { useOnDeviceSpeech } from './on-device-speech.web'

function mountSpeech(removeFillerWords: boolean): OnDeviceSpeech {
  let speech: OnDeviceSpeech | null = null
  function Probe(): null {
    speech = useOnDeviceSpeech(removeFillerWords)
    return null
  }
  act(() => {
    create(createElement(Probe))
  })
  if (speech === null) {
    throw new Error('no on-device speech')
  }
  return speech
}

describe('on-device dictation text', () => {
  it('drops the fillers of the language the recognizer started in', async () => {
    const speech = mountSpeech(true)
    await speech.start()

    expect(await speech.read()).toMatchObject({ committed: 'Das ist um fünf Uhr.', tentative: '' })
    expect(await speech.finish()).toEqual({
      text: 'Das ist um fünf Uhr fertig.',
      failure: null
    })
  })
})
