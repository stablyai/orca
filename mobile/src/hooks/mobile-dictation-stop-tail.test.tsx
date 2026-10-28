// Page capture.end delivers the final audio chunk; keep accepting chunks until it settles and snapshot pending sends afterward, or finish loses the sentence tail.
// A fake delivering audio inside end distinguishes this ordering; native capture and source-text checks do not.
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
} from '../platform/dictation-capture-contract'

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
vi.mock('../platform/dictation-capture', () => {
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

function settle(rpc: FakeRpcClient, sent: SentRequest[]): void {
  for (const request of rpc.requests.splice(0)) {
    sent.push(request)
    request.resolve({
      id: 'desktop',
      ok: true,
      result: request.method === 'speech.dictation.finish' ? { text: 'a sentence' } : {}
    })
  }
}

// Drain chained requests; each reply can unblock the next.
async function pump(rpc: FakeRpcClient, sent: SentRequest[]): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    settle(rpc, sent)
    await Promise.resolve()
    await Promise.resolve()
  }
}

function audioOf(request: SentRequest): unknown {
  const params = request.args[1]
  return typeof params === 'object' && params !== null && 'audioBase64' in params
    ? params.audioBase64
    : null
}

function settleExcept(rpc: FakeRpcClient, sent: SentRequest[], method: string): void {
  for (const request of rpc.requests.splice(0)) {
    sent.push(request)
    if (request.method === method) {
      rpc.requests.push(request)
      continue
    }
    request.resolve({ id: 'desktop', ok: true, result: {} })
  }
}

const held: { dictation: UseMobileDictationResult | null } = { dictation: null }

function mount(client: FakeRpcClient, onTranscript: (text: string) => void = () => {}): void {
  function Probe(): null {
    held.dictation = useMobileDictation({
      client,
      enabled: true,
      onTranscript,
      onError: () => {}
    })
    return null
  }
  act(() => {
    create(createElement(Probe))
  })
}

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

describe('the audio a capture hands over as it ends', () => {
  it('is still accepted, and reaches the desktop before the finish', async () => {
    const rpc = createFakeRpcClient()
    const sent: SentRequest[] = []
    mount(rpc)
    await act(async () => {
      const started = dictation().start()
      await pump(rpc, sent)
      await started
    })
    seam.tail = Uint8Array.from([7, 8, 9, 10])
    await act(async () => {
      const stopped = dictation().stop()
      await pump(rpc, sent)
      await stopped
    })
    const methods = sent.map((request) => request.method)
    expect(methods).toContain('speech.dictation.chunk')
    // Disabling acceptingChunksRef before end would silently drop this last audio.
    const chunk = sent.find((request) => request.method === 'speech.dictation.chunk')
    expect(chunk === undefined ? null : audioOf(chunk)).toBe('BwgJCg==')
    expect(methods.indexOf('speech.dictation.chunk')).toBeLessThan(
      methods.indexOf('speech.dictation.finish')
    )
  })

  it('stops being accepted once the capture has ended', async () => {
    const rpc = createFakeRpcClient()
    const sent: SentRequest[] = []
    mount(rpc)
    await act(async () => {
      const started = dictation().start()
      await pump(rpc, sent)
      await started
    })
    await act(async () => {
      const stopped = dictation().stop()
      await pump(rpc, sent)
      await stopped
    })
    const before = sent.filter((request) => request.method === 'speech.dictation.chunk').length
    for (const handler of seam.chunkHandlers) {
      handler({ data: Uint8Array.from([1, 2, 3, 4]), droppedBytes: 0 })
    }
    await act(async () => {
      await pump(rpc, sent)
    })
    expect(sent.filter((request) => request.method === 'speech.dictation.chunk')).toHaveLength(
      before
    )
  })
})

describe('a finish whose dictation stopped being the current one', () => {
  it('delivers no transcript when a cancel lands while the finish is in flight', async () => {
    // Cancel bumps generation and clears the active id; a late finish must not type into a composer whose microphone was dismissed.
    const rpc = createFakeRpcClient()
    const sent: SentRequest[] = []
    const transcripts: string[] = []
    mount(rpc, (text) => transcripts.push(text))
    await act(async () => {
      const started = dictation().start()
      await pump(rpc, sent)
      await started
    })
    let stopped: Promise<void> = Promise.resolve()
    await act(async () => {
      stopped = dictation().stop()
      for (let round = 0; round < 4; round += 1) {
        settleExcept(rpc, sent, 'speech.dictation.finish')
        await Promise.resolve()
        await Promise.resolve()
      }
    })
    expect(sent.map((request) => request.method)).toContain('speech.dictation.finish')
    await act(async () => {
      // Start without awaiting: the pump must answer cancel’s request before it can settle.
      const cancelled = dictation().cancel()
      await pump(rpc, sent)
      await cancelled
      await stopped
    })
    expect(transcripts).toEqual([])
    expect(dictation().status).toBe('idle')
  })
})
