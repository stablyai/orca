// A computer dictation that fails mid-session keeps its whole recording; Retry plays all of it to the computer as a new dictation.
import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createFakeRpcClient,
  type FakeRpcClient,
  type SentRequest
} from '../mobile-web-shell/bridge-host-test-fakes'
import type {
  DictationCapture,
  DictationCaptureChunk
} from '../platform/audio-capture/dictation-capture-contract'

type Seam = {
  chunkHandlers: Set<(chunk: DictationCaptureChunk) => void>
  tail: Uint8Array | null
}

const seam = vi.hoisted((): Seam => ({ chunkHandlers: new Set(), tail: null }))

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  Platform: { OS: 'ios' }
}))

// Keep capture identity stable like both real seams; a fresh object on render would rerun teardown and cancel dictation.
vi.mock('../platform/audio-capture/dictation-capture', () => {
  const capture: DictationCapture = {
    open: async () => ({ ok: true }),
    begin: () => true,
    end: async () => {
      // Page capture reads once more here and may deliver audio.
      const tail = seam.tail
      seam.tail = null
      if (tail !== null) {
        for (const handler of seam.chunkHandlers) {
          handler({ data: tail, droppedBytes: 0 })
        }
      }
    },
    release: () => {},
    onChunk: (handler) => {
      seam.chunkHandlers.add(handler)
      return {
        remove: () => {
          seam.chunkHandlers.delete(handler)
        }
      }
    },
    onInterruption: () => ({ remove: () => {} })
  }
  return { useDictationCapture: () => capture }
})

import { useMobileDictation, type UseMobileDictationResult } from './use-mobile-dictation'

type Reply = (request: SentRequest) => 'hold' | { text?: string } | Error

// Answer every request; one reply can unblock the next.
async function pump(rpc: FakeRpcClient, sent: SentRequest[], reply: Reply): Promise<void> {
  for (let round = 0; round < 30; round += 1) {
    for (const request of rpc.requests.splice(0)) {
      sent.push(request)
      const answer = reply(request)
      if (answer === 'hold') {
        continue
      }
      if (answer instanceof Error) {
        request.reject(answer)
      } else {
        request.resolve({ id: 'desktop', ok: true, result: answer })
      }
    }
    await Promise.resolve()
    await Promise.resolve()
  }
}

function paramsOf(request: SentRequest): Record<string, unknown> {
  const params = request.args[1]
  return typeof params === 'object' && params !== null ? { ...params } : {}
}

function deliver(bytes: number[]): void {
  for (const handler of seam.chunkHandlers) {
    handler({ data: Uint8Array.from(bytes), droppedBytes: 0 })
  }
}

const held: { dictation: UseMobileDictationResult | null } = { dictation: null }

function dictation(): UseMobileDictationResult {
  const current = held.dictation
  if (current === null) {
    throw new Error('nothing mounted')
  }
  return current
}

beforeEach(() => {
  seam.chunkHandlers.clear()
  seam.tail = null
  held.dictation = null
})

describe('a computer dictation whose finish fails', () => {
  it('keeps the recording, and Retry sends all of it again and inserts the words', async () => {
    const rpc = createFakeRpcClient()
    const sent: SentRequest[] = []
    const inserted: string[] = []
    const errors: { message: string; kept: boolean }[] = []
    function Probe(): null {
      held.dictation = useMobileDictation({
        client: rpc,
        enabled: true,
        onTranscript: (text) => inserted.push(text),
        onError: (error, outcome) => errors.push({ message: error.message, kept: outcome.kept })
      })
      return null
    }
    act(() => {
      create(createElement(Probe))
    })
    const firstTry: Reply = (request) =>
      request.method === 'speech.dictation.finish' ? new Error('connection lost') : {}
    await act(async () => {
      const started = dictation().start()
      await pump(rpc, sent, firstTry)
      await started
    })
    await act(async () => {
      deliver([1, 2, 3, 4])
      await pump(rpc, sent, firstTry)
    })
    seam.tail = Uint8Array.from([5, 6])
    await act(async () => {
      const stopped = dictation().stop()
      await pump(rpc, sent, firstTry)
      await stopped
    })
    expect(inserted).toEqual([])
    expect(errors).toEqual([{ message: 'connection lost', kept: true }])
    expect(dictation().failure).toEqual({ message: 'connection lost', offline: false })

    const firstId = paramsOf(sent[0]).dictationId
    sent.length = 0
    await act(async () => {
      const retried = dictation().retry()
      await pump(rpc, sent, (request) =>
        request.method === 'speech.dictation.finish' ? { text: 'all of it' } : {}
      )
      await retried
    })
    expect(sent.map((request) => request.method)).toEqual([
      'speech.dictation.start',
      'speech.dictation.chunk',
      'speech.dictation.finish'
    ])
    expect(paramsOf(sent[0]).dictationId).not.toBe(firstId)
    // The whole recording, from the first byte, as seq 0 of the new dictation.
    expect(paramsOf(sent[1])).toMatchObject({ audioBase64: 'AQIDBAUG', seq: 0 })
    expect(inserted).toEqual(['all of it'])
    expect(dictation().failure).toBeNull()
  })
})
