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

describe('text a cancelled session sends while the next one is arming', () => {
  it('is dropped rather than shown as the new dictation’s words', async () => {
    const text: {
      emit: (event: { revision: number; committed: string; tentative: string }) => void
    } = {
      emit: () => {}
    }
    let resolveStart: (value: { started: true; locale: string }) => void = () => {}
    const engine: NativeSpeechEngine = {
      ...engineWith('automatic'),
      start: () =>
        new Promise((resolve) => {
          resolveStart = resolve
        }),
      onText: (handler) => {
        text.emit = handler
      }
    }
    const server = createNativeSpeechServer(engine)
    const starting = server.serve({ action: 'start', locale: 'en-US' })
    text.emit({ revision: 3, committed: 'old words', tentative: '' })
    resolveStart({ started: true, locale: 'en-US' })
    await starting
    expect(await server.serve({ action: 'read' })).toMatchObject({ committed: '' })
    text.emit({ revision: 1, committed: 'new words', tentative: '' })
    expect(await server.serve({ action: 'read' })).toMatchObject({ committed: 'new words' })
  })
})

describe('a recognizer that fails while its start is still resolving', () => {
  it('reports the failure once armed, so the page stops recording into nothing', async () => {
    const error: { emit: (code: string) => void } = { emit: () => {} }
    let resolveStart: (value: { started: true; locale: string }) => void = () => {}
    const engine: NativeSpeechEngine = {
      ...engineWith('automatic'),
      start: () =>
        new Promise((resolve) => {
          resolveStart = resolve
        }),
      onError: (handler) => {
        error.emit = handler
      }
    }
    const server = createNativeSpeechServer(engine)
    const starting = server.serve({ action: 'start', locale: 'en-US' })
    error.emit('failed')
    resolveStart({ started: true, locale: 'en-US' })
    await starting
    expect(await server.serve({ action: 'read' })).toMatchObject({ failure: 'failed' })
  })
})
