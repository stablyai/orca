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
} from '../platform/dictation-capture-contract'
import type { OnDeviceSpeech } from '../platform/on-device-speech-contract'
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

vi.mock('../platform/dictation-capture', () => {
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

vi.mock('../platform/on-device-speech', () => {
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

describe('a dictation the phone can hear', () => {
  it('records without the computer and inserts the phone’s text', async () => {
    const rpc = createFakeRpcClient()
    const sent: SentRequest[] = []
    const transcripts: string[] = []
    mount(rpc, (text) => transcripts.push(text))
    await act(async () => {
      await dictation().start()
    })
    expect(dictation().status).toBe('recording')
    speak([1, 2, 3, 4])
    seam.finish = { text: ' hello phone ', failure: null }
    await act(async () => {
      const stopped = dictation().stop()
      await pump(rpc, sent)
      await stopped
    })
    expect(transcripts).toEqual(['hello phone'])
    expect(sent).toEqual([])
    expect(dictation().status).toBe('idle')
  })
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

describe('a phone recognizer that fails after a long dictation', () => {
  it('replays all of it to the computer instead of calling the connection slow', async () => {
    const rpc = createFakeRpcClient()
    const sent: SentRequest[] = []
    const transcripts: string[] = []
    mount(rpc, (text) => transcripts.push(text))
    await act(async () => {
      await dictation().start()
    })
    // 40 s of 16 kHz PCM: more than the 30 s the host may have pending at once.
    for (let second = 0; second < 40; second += 1) {
      speak(Array.from({ length: 32_000 }, () => second))
    }
    seam.finish = { text: null, failure: 'failed' }
    await act(async () => {
      const stopped = dictation().stop()
      await pump(rpc, sent)
      await stopped
    })
    expect(held.errors).toEqual([])
    expect(chunkAudio(sent).map(([seq]) => seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(transcripts).toEqual(['from the computer'])
  })
})

describe('a stop while a failed phone dictation is reaching the computer', () => {
  it('finishes on the computer once its start lands, with the audio kept so far', async () => {
    const rpc = createFakeRpcClient()
    const sent: SentRequest[] = []
    const transcripts: string[] = []
    mount(rpc, (text) => transcripts.push(text))
    await act(async () => {
      await dictation().start()
    })
    speak([1, 2, 3])
    seam.read = { revision: 1, committed: '', tentative: '', failure: 'failed' }
    // The drain tick reads the failure and starts the computer's session.
    await act(async () => {
      await vi.waitFor(() =>
        expect(rpc.requests.map((request) => request.method)).toEqual(['speech.dictation.start'])
      )
    })
    await act(async () => {
      const stopped = dictation().stop()
      await pump(rpc, sent)
      await stopped
    })
    expect(sent.map((request) => request.method)).toEqual([
      'speech.dictation.start',
      'speech.dictation.chunk',
      'speech.dictation.finish'
    ])
    expect(transcripts).toEqual(['from the computer'])
    expect(dictation().status).toBe('idle')
  })
})

describe('a dictation when the user chose Computer', () => {
  it('goes to the computer and never arms the phone', async () => {
    seam.preference = 'computer'
    const rpc = createFakeRpcClient()
    const sent: SentRequest[] = []
    mount(rpc, () => {})
    await act(async () => {
      const started = dictation().start()
      await pump(rpc, sent)
      await started
    })
    expect(sent.map((request) => request.method)).toEqual(['speech.dictation.start'])
    expect(seam.calls).toEqual([])
  })
})
