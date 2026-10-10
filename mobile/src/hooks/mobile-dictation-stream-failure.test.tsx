/**
 * A provider stream that dies mid-dictation: the host marks the chunk refusal with a stable prefix,
 * and the phone finishes (inserting the committed text) instead of discarding it with a cancel.
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

type Seam = {
  chunkHandlers: Set<(chunk: DictationCaptureChunk) => void>
  /** Bytes the capture is still holding when `end()` is called, as the shell's ring would be. */
  tail: Uint8Array | null
}

const seam = vi.hoisted((): Seam => ({ chunkHandlers: new Set(), tail: null }))

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  Platform: { OS: 'ios' }
}))

// One object for the life of the module, because the hook keys its effects on the capture's
// identity: the teardown effect runs whenever it changes, so a seam returning a fresh object per
// render would cancel the dictation on every render. Both real seams are stable — the native one is
// a module const, the page's is a `useMemo` on the client.
vi.mock('../platform/dictation-capture', () => {
  const capture: DictationCapture = {
    open: async () => ({ ok: true }),
    begin: () => true,
    end: async () => {
      // The page's seam reads once more here, and that read can carry audio.
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

const held: { dictation: UseMobileDictationResult | null } = { dictation: null }

type FinishReply = { text: string; error?: string } | 'hold'

/** Answers every request; chunks are refused with `chunkError`, finish answers `finishReply`. */
async function pump(
  rpc: FakeRpcClient,
  sent: SentRequest[],
  chunkError: string,
  finishReply: FinishReply = { text: 'kept words' }
): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    for (const request of rpc.requests.splice(0)) {
      sent.push(request)
      if (request.method === 'speech.dictation.chunk') {
        request.resolve({
          id: 'desktop',
          ok: false,
          error: { code: 'runtime_error', message: chunkError }
        })
        continue
      }
      const isFinish = request.method === 'speech.dictation.finish'
      if (isFinish && finishReply === 'hold') {
        continue
      }
      request.resolve({ id: 'desktop', ok: true, result: isFinish ? finishReply : {} })
    }
    await Promise.resolve()
    await Promise.resolve()
  }
}

async function recordAndFailChunk(chunkError: string, finishReply?: FinishReply) {
  const rpc = createFakeRpcClient()
  const sent: SentRequest[] = []
  const onTranscript = vi.fn()
  const onError = vi.fn()
  function Probe(): null {
    held.dictation = useMobileDictation({ client: rpc, enabled: true, onTranscript, onError })
    return null
  }
  act(() => {
    create(createElement(Probe))
  })
  await act(async () => {
    const started = held.dictation?.start()
    await pump(rpc, sent, chunkError)
    await started
  })
  await act(async () => {
    for (const handler of seam.chunkHandlers) {
      handler({ data: Uint8Array.from([1, 2, 3, 4]), droppedBytes: 0 })
      handler({ data: Uint8Array.from([5, 6, 7, 8]), droppedBytes: 0 })
    }
    await pump(rpc, sent, chunkError, finishReply)
    await pump(rpc, sent, chunkError, finishReply)
  })
  return { methods: sent.map((request) => request.method), onTranscript, onError }
}

beforeEach(() => {
  seam.chunkHandlers.clear()
  seam.tail = null
  held.dictation = null
})

describe('a dictation whose provider stream failed', () => {
  it('finishes once and inserts the committed text, then shows the provider error', async () => {
    const { methods, onTranscript, onError } = await recordAndFailChunk(
      'dictation_stream_failed: Soniox closed the stream (1000).'
    )

    expect(methods.filter((method) => method === 'speech.dictation.finish')).toHaveLength(1)
    expect(methods).not.toContain('speech.dictation.cancel')
    expect(onTranscript).toHaveBeenCalledWith('kept words')
    expect(onError).toHaveBeenCalledWith(new Error('Soniox closed the stream (1000).'))
    expect(held.dictation?.status).toBe('error')
  })

  it('shows the provider error once when the finish reply repeats it', async () => {
    const { onTranscript, onError } = await recordAndFailChunk(
      'dictation_stream_failed: Soniox closed the stream (1000).',
      { text: 'kept words', error: 'Soniox closed the stream (1000).' }
    )
    expect(onTranscript).toHaveBeenCalledWith('kept words')
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(new Error('Soniox closed the stream (1000).'))
  })

  it('reports the failed stream finish while it is underway, so a tap does not discard it', async () => {
    await recordAndFailChunk('dictation_stream_failed: Soniox closed the stream (1000).', 'hold')
    expect(held.dictation?.status).toBe('processing')
    expect(held.dictation?.failedStreamFinish).toBe('grace')
  })

  it('still cancels on any other chunk failure', async () => {
    const { methods, onTranscript, onError } = await recordAndFailChunk('dictation_owner_mismatch')

    expect(methods).toContain('speech.dictation.cancel')
    expect(methods).not.toContain('speech.dictation.finish')
    expect(onTranscript).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(new Error('dictation_owner_mismatch'))
  })
})
