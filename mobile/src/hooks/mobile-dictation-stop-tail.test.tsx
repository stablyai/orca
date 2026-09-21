/**
 * The ordering `stop()` depends on: the capture hands over its tail, and only then does the flow
 * stop accepting chunks.
 *
 * On the page the tail is real audio — up to one drain interval of what the user was still saying
 * as they lifted the button, fetched by the last read inside `end()`. Refusing chunks first drops
 * exactly that, and taking the pending set before it lets `finish` overtake the last send. Neither
 * shows up in a source-text check: both orders put `end()` before `Promise.allSettled`, and
 * reversing the two lines left the whole mobile suite green.
 *
 * Driven against a capture whose `end()` delivers a chunk, which is what the page's seam does and
 * what the device's never does, so this is the one case that can tell the orders apart.
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
    onInterruption: () => ({ remove: () => {} }),
    keepAwake: { activate: async () => {}, deactivate: async () => {} }
  }
  return { useDictationCapture: () => capture }
})

import { useMobileDictation, type UseMobileDictationResult } from './use-mobile-dictation'

/** The desktop, answering whatever the hook forwards. `finish` carries the transcript, which is
 *  the one reply the flow reads. */
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

/** The base64 a chunk request carried, read by narrowing rather than asserted: the fake records
 *  whatever the hook passed, and this is a test of what that was. */
/** Drains and answers whatever the hook sends, for as long as it keeps sending: one dictation is a
 *  chain of requests where each is only made once the one before it settled. */
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

const held: { dictation: UseMobileDictationResult | null } = { dictation: null }

function mount(client: FakeRpcClient): void {
  function Probe(): null {
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
    // What the user was still saying when they lifted the button, which no timer will come for.
    seam.tail = Uint8Array.from([7, 8, 9, 10])
    await act(async () => {
      const stopped = dictation().stop()
      await pump(rpc, sent)
      await stopped
    })
    const methods = sent.map((request) => request.method)
    expect(methods).toContain('speech.dictation.chunk')
    // Refusing chunks before `end()` drops this one silently: the handler reads
    // `acceptingChunksRef` and returns, and the transcript loses the end of the sentence.
    const chunk = sent.find((request) => request.method === 'speech.dictation.chunk')
    expect(chunk === undefined ? null : audioOf(chunk)).toBe('BwgJCg==')
    // And it is sent before the finish, or the desktop transcribes without it.
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
    // A late event from a capture that has already ended is not this dictation's audio.
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
