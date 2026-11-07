import { describe, expect, it } from 'vitest'
import type { DictationEnginePreference } from '../mobile-web-shell/bridge/bridge-speech-verbs'
import { createNativeSpeechServer, type NativeSpeechEngine } from './native-speech'

function engineWith(preference: DictationEnginePreference): NativeSpeechEngine {
  return {
    availability: async () => ({ status: 'ready', locale: 'en-US' }),
    start: async (locale) => ({ started: true, locale }),
    finish: async () => '',
    cancel: () => {},
    readPreference: async () => preference,
    onText: () => {},
    onError: () => {}
  }
}

describe('a page asking for the microphone when the user chose This phone', () => {
  it('is refused unless its own recognizer is armed', async () => {
    const server = createNativeSpeechServer(engineWith('phone'))
    // An older page streams the mic to the computer without arming anything.
    expect(await server.mayCapture()).toBe(false)
    await server.serve({ action: 'start', locale: 'en-US' })
    expect(await server.mayCapture()).toBe(true)
    await server.serve({ action: 'cancel' })
    expect(await server.mayCapture()).toBe(false)
  })

  it('is allowed under Automatic, where the computer is a fallback', async () => {
    const server = createNativeSpeechServer(engineWith('automatic'))
    expect(await server.mayCapture()).toBe(true)
  })
})

describe('a recognizer another page took over', () => {
  it('reports the first page’s session as failed so it falls back', async () => {
    const engine = engineWith('automatic')
    const first = createNativeSpeechServer(engine)
    const second = createNativeSpeechServer(engine)
    await first.serve({ action: 'start', locale: 'en-US' })
    await second.serve({ action: 'start', locale: 'en-US' })
    expect(await first.serve({ action: 'read' })).toEqual({
      revision: 0,
      committed: '',
      tentative: '',
      failure: 'failed'
    })
    expect(await second.serve({ action: 'read' })).toMatchObject({ failure: null })
  })
})
