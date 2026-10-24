import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpeechOptions } from 'expo-speech'

const speech = vi.hoisted(() => {
  const calls: { text: string; options: SpeechOptions }[] = []
  return { calls, stops: 0 }
})

vi.mock('expo-speech', () => ({
  speak: (text: string, options: SpeechOptions) => {
    speech.calls.push({ text, options })
  },
  stop: () => {
    speech.stops += 1
    return Promise.resolve()
  }
}))

import { serveNativeSpeechVerb, speakOnDevice } from './native-speech'

beforeEach(() => {
  speech.calls.length = 0
  speech.stops = 0
})

describe('native.speech.speak on the device', () => {
  it('answers finished once the last part has been spoken', async () => {
    const reply = serveNativeSpeechVerb({ text: 'Hello there.' })
    speech.calls.at(-1)?.options.onDone?.()
    await expect(reply).resolves.toEqual({ finished: true })
  })

  it('answers not finished for a reading a newer one replaced', async () => {
    const first = speakOnDevice('First reply.')
    const second = speakOnDevice('Second reply.')
    await expect(first).resolves.toBe(false)
    speech.calls.at(-1)?.options.onDone?.()
    await expect(second).resolves.toBe(true)
  })

  it('stops on empty text', async () => {
    const reading = speakOnDevice('A long reply.')
    await expect(serveNativeSpeechVerb({ text: '' })).resolves.toEqual({ finished: false })
    await expect(reading).resolves.toBe(false)
    expect(speech.stops).toBeGreaterThan(0)
  })

  it('refuses params the verb does not take', async () => {
    await expect(serveNativeSpeechVerb({ text: 'Hi.', rate: 2 })).rejects.toThrow()
  })
})
