/**
 * The caption useMobileDictation exposes while recording: read off chunk replies, ordered by the
 * host's revision, and gone once the user stops.
 */
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

const seam = vi.hoisted(() => ({
  chunkHandlers: new Set<(chunk: DictationCaptureChunk) => void>()
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

import { useMobileDictation, type UseMobileDictationResult } from './use-mobile-dictation'

const held: { dictation: UseMobileDictationResult | null; renders: number } = {
  dictation: null,
  renders: 0
}

function mount(client: FakeRpcClient): void {
  function Probe(): null {
    held.renders += 1
    held.dictation = useMobileDictation({
      client,
      enabled: true,
      onTranscript: () => {},
      onError: () => {}
    })
    return null
  }
  act(() => {
    create(createElement(Probe))
  })
}

function current(): UseMobileDictationResult {
  if (!held.dictation) {
    throw new Error('nothing mounted')
  }
  return held.dictation
}

function caption(): string {
  return current().captionStore.getSnapshot()
}

function answerAll(rpc: FakeRpcClient, result: (request: SentRequest) => unknown): void {
  for (const request of rpc.requests.splice(0)) {
    request.resolve({ id: 'desktop', ok: true, result: result(request) })
  }
}

async function flush(): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    await Promise.resolve()
  }
}

function emitChunk(): void {
  for (const handler of seam.chunkHandlers) {
    handler({ data: Uint8Array.from([1, 2, 3, 4]), droppedBytes: 0 })
  }
}

async function startRecording(rpc: FakeRpcClient): Promise<void> {
  await act(async () => {
    const started = current().start()
    for (let round = 0; round < 4; round += 1) {
      answerAll(rpc, () => ({}))
      await flush()
    }
    await started
  })
  expect(current().isRecording).toBe(true)
}

beforeEach(() => {
  seam.chunkHandlers.clear()
  held.dictation = null
  held.renders = 0
})

describe('live dictation captions', () => {
  it('shows the newest caption and drops a reply that lands out of order', async () => {
    const rpc = createFakeRpcClient()
    mount(rpc)
    await startRecording(rpc)
    expect(caption()).toBe('')

    emitChunk()
    emitChunk()
    const [first, second] = rpc.requests.splice(0)
    await act(async () => {
      second?.resolve({
        id: 'd',
        ok: true,
        result: { caption: { text: 'hello world', revision: 2 } }
      })
      await flush()
      first?.resolve({ id: 'd', ok: true, result: { caption: { text: 'hello', revision: 1 } } })
      await flush()
    })
    expect(caption()).toBe('hello world')
  })

  it('stays empty against a desktop that sends no caption', async () => {
    const rpc = createFakeRpcClient()
    mount(rpc)
    await startRecording(rpc)
    emitChunk()
    await act(async () => {
      answerAll(rpc, () => ({ received: true }))
      await flush()
    })
    expect(caption()).toBe('')
    expect(current().isRecording).toBe(true)
  })

  it('clears the caption once the user stops', async () => {
    const rpc = createFakeRpcClient()
    mount(rpc)
    await startRecording(rpc)
    emitChunk()
    await act(async () => {
      answerAll(rpc, () => ({ caption: { text: 'almost done', revision: 1 } }))
      await flush()
    })
    expect(caption()).toBe('almost done')
    await act(async () => {
      const stopped = current().stop()
      for (let round = 0; round < 6; round += 1) {
        answerAll(rpc, (request) =>
          request.method === 'speech.dictation.finish' ? { text: 'almost done' } : {}
        )
        await flush()
      }
      await stopped
    })
    expect(caption()).toBe('')
  })

  it('updates the caption without re-rendering the component that owns the dictation', async () => {
    const rpc = createFakeRpcClient()
    mount(rpc)
    await startRecording(rpc)
    const rendersWhileRecording = held.renders
    const seen: string[] = []
    const unsubscribe = current().captionStore.subscribe(() => seen.push(caption()))
    for (const [revision, text] of [
      [1, 'one'],
      [2, 'one two']
    ] as const) {
      emitChunk()
      await act(async () => {
        answerAll(rpc, () => ({ caption: { text, revision } }))
        await flush()
      })
    }
    unsubscribe()
    expect(seen).toEqual(['one', 'one two'])
    expect(held.renders).toBe(rendersWhileRecording)
  })

  it('clears the caption when a newer revision empties it', async () => {
    const rpc = createFakeRpcClient()
    mount(rpc)
    await startRecording(rpc)
    for (const [revision, text] of [
      [1, 'maybe'],
      [2, '']
    ] as const) {
      emitChunk()
      await act(async () => {
        answerAll(rpc, () => ({ caption: { text, revision } }))
        await flush()
      })
    }
    expect(caption()).toBe('')
    expect(current().isRecording).toBe(true)
  })
})
