// The phone's recognizer hears the dictation first; when it fails, the audio the page kept replays to the computer.
import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as z from 'zod'
import {
  createFakeRpcClient,
  type FakeRpcClient,
  type SentRequest
} from '../mobile-web-shell/bridge-host-test-fakes'
import type {
  DictationCapture,
  DictationCaptureChunk
} from '../platform/audio-capture/dictation-capture-contract'
import type { OnDeviceSpeech } from '../platform/speech/on-device-speech-contract'
import type {
  BridgeSpeechFinish,
  BridgeSpeechRead,
  DictationEnginePreference
} from '../mobile-web-shell/bridge/bridge-speech-verbs'

type Seam = {
  chunkHandlers: Set<(chunk: DictationCaptureChunk) => void>
  preference: DictationEnginePreference
  read: BridgeSpeechRead
  finish: BridgeSpeechFinish
  calls: string[]
}

const seam = vi.hoisted((): Seam => ({
  chunkHandlers: new Set(),
  preference: 'automatic',
  read: { revision: 0, committed: '', tentative: '', failure: null },
  finish: { text: '', failure: null },
  calls: []
}))

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  Platform: { OS: 'ios' }
}))

vi.mock('../platform/audio-capture/dictation-capture', () => {
  const capture: DictationCapture = {
    open: async () => ({ ok: true }),
    begin: () => true,
    end: async () => {},
    release: () => {},
    onChunk: (handler) => {
      seam.chunkHandlers.add(handler)
      return { remove: () => seam.chunkHandlers.delete(handler) }
    },
    onInterruption: () => ({ remove: () => {} })
  }
  return { useDictationCapture: () => capture }
})

vi.mock('../platform/speech/on-device-speech', () => {
  const speech: OnDeviceSpeech = {
    status: async () => ({
      status: 'ready',
      locale: 'en-US',
      preference: seam.preference
    }),
    start: async () => {
      seam.calls.push('start')
      return { started: true, locale: 'en-US', reason: null }
    },
    read: async () => seam.read,
    finish: async () => {
      seam.calls.push('finish')
      return seam.finish
    },
    cancel: () => {
      seam.calls.push('cancel')
    }
  }
  return { useOnDeviceSpeech: () => speech }
})

import { useMobileDictation, type UseMobileDictationResult } from './use-mobile-dictation'

const held: { dictation: UseMobileDictationResult | null; errors: string[] } = {
  dictation: null,
  errors: []
}

function mount(client: FakeRpcClient, onTranscript: (text: string) => void): void {
  function Probe(): null {
    held.dictation = useMobileDictation({
      client,
      enabled: true,
      onTranscript,
      onError: (error) => held.errors.push(error.message)
    })
    return null
  }
  act(() => {
    create(createElement(Probe))
  })
}

function dictation(): UseMobileDictationResult {
  if (held.dictation === null) {
    throw new Error('nothing mounted')
  }
  return held.dictation
}

function speak(bytes: number[]): void {
  for (const handler of seam.chunkHandlers) {
    handler({ data: Uint8Array.from(bytes), droppedBytes: 0 })
  }
}

async function pump(rpc: FakeRpcClient, sent: SentRequest[]): Promise<void> {
  for (let round = 0; round < 40; round += 1) {
    for (const request of rpc.requests.splice(0)) {
      sent.push(request)
      request.resolve({
        id: 'desktop',
        ok: true,
        result: request.method === 'speech.dictation.finish' ? { text: 'from the computer' } : {}
      })
    }
    await Promise.resolve()
    await Promise.resolve()
  }
}

const chunkParamsSchema = z.object({ seq: z.number(), audioBase64: z.string() })

function chunkAudio(sent: SentRequest[]): [number, string][] {
  return sent
    .filter((request) => request.method === 'speech.dictation.chunk')
    .map((request): [number, string] => {
      const params = chunkParamsSchema.parse(request.args[1])
      return [params.seq, params.audioBase64]
    })
}

beforeEach(() => {
  seam.chunkHandlers.clear()
  seam.preference = 'automatic'
  seam.read = { revision: 0, committed: '', tentative: '', failure: null }
  seam.finish = { text: '', failure: null }
  seam.calls = []
  held.dictation = null
  held.errors = []
})

describe('a phone recognizer that fails at the finish', () => {
  it('replays what was said to the computer and inserts its text', async () => {
    const rpc = createFakeRpcClient()
    const sent: SentRequest[] = []
    const transcripts: string[] = []
    mount(rpc, (text) => transcripts.push(text))
    await act(async () => {
      await dictation().start()
    })
    speak([1, 2, 3])
    speak([4, 5, 6])
    seam.finish = { text: null, failure: 'failed' }
    await act(async () => {
      const stopped = dictation().stop()
      await pump(rpc, sent)
      await stopped
    })
    const methods = sent.map((request) => request.method)
    expect(methods).toEqual([
      'speech.dictation.start',
      'speech.dictation.chunk',
      'speech.dictation.finish'
    ])
    // Both utterances, merged in order, starting the computer's sequence at zero.
    expect(chunkAudio(sent)).toEqual([[0, 'AQIDBAUG']])
    expect(transcripts).toEqual(['from the computer'])
    expect(held.errors).toEqual([])
  })

  it('never sends the audio anywhere when the user chose This phone', async () => {
    seam.preference = 'phone'
    const rpc = createFakeRpcClient()
    const sent: SentRequest[] = []
    const transcripts: string[] = []
    mount(rpc, (text) => transcripts.push(text))
    await act(async () => {
      await dictation().start()
    })
    speak([1, 2, 3])
    seam.finish = { text: null, failure: 'failed' }
    await act(async () => {
      const stopped = dictation().stop()
      await pump(rpc, sent)
      await stopped
    })
    expect(sent).toEqual([])
    expect(transcripts).toEqual([])
    expect(held.errors).toHaveLength(1)
    expect(dictation().status).toBe('error')
  })
})
