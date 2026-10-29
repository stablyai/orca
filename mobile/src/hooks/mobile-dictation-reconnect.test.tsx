// The host keeps a phone's dictation through a reconnect; the phone must not end it over the chunks the drop took with it.
import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createFakeRpcClient,
  type FakeRpcClient,
  type SentRequest
} from '../mobile-web-shell/bridge-host-test-fakes'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { LogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import type { ConnectionState } from '../transport/types'
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

type Reply = { text?: string } | Error

const held: { dictation: UseMobileDictationResult | null } = { dictation: null }

function mount(rpc: FakeRpcClient, transcripts: string[], errors: string[]): void {
  function Probe(): null {
    held.dictation = useMobileDictation({
      client: rpc,
      enabled: true,
      onTranscript: (text) => transcripts.push(text),
      onError: (err) => errors.push(err.message)
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

// Answer chunks and finishes with the next scripted reply, and everything else with success.
async function pump(
  rpc: FakeRpcClient,
  sent: SentRequest[],
  chunkReplies: Reply[],
  finishReplies: Reply[] = []
): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    for (const request of rpc.requests.splice(0)) {
      sent.push(request)
      const reply: Reply =
        request.method === 'speech.dictation.chunk'
          ? (chunkReplies.shift() ?? {})
          : request.method === 'speech.dictation.finish'
            ? (finishReplies.shift() ?? { text: 'hello world' })
            : {}
      if (reply instanceof Error) {
        request.reject(reply)
      } else {
        request.resolve({ id: 'desktop', ok: true, result: reply })
      }
    }
    await Promise.resolve()
    await Promise.resolve()
  }
}

async function record(rpc: FakeRpcClient, sent: SentRequest[], chunkReplies: Reply[]) {
  await act(async () => {
    const started = dictation().start()
    await pump(rpc, sent, [])
    await started
  })
  for (const reply of chunkReplies) {
    await act(async () => {
      for (const handler of seam.chunkHandlers) {
        handler({ data: Uint8Array.from([1, 2]), droppedBytes: 0 })
      }
      await pump(rpc, sent, [reply])
    })
  }
}

const methodsOf = (sent: SentRequest[]) => sent.map((request) => request.method)

beforeEach(() => {
  seam.chunkHandlers.clear()
  held.dictation = null
})

describe('dictation through a reconnect', () => {
  it('keeps recording past chunks the drop lost, and resends requests that never left', async () => {
    const rpc = createFakeRpcClient()
    const sent: SentRequest[] = []
    const transcripts: string[] = []
    const errors: string[] = []
    mount(rpc, transcripts, errors)

    await record(rpc, sent, [
      { text: 'hello' },
      markRpcDeliveryUnknown(new Error('Connection interrupted')),
      new LogicalClientCutoverError(new Error('Connection closed'))
    ])

    expect(dictation().status).toBe('recording')
    // Each captured chunk went out once, and the one the cutover held back went out again.
    expect(methodsOf(sent).filter((m) => m === 'speech.dictation.chunk')).toHaveLength(4)
    await act(async () => {
      const stopped = dictation().stop()
      await pump(rpc, sent, [], [new LogicalClientCutoverError(new Error('Connection closed'))])
      await stopped
    })
    expect(methodsOf(sent).filter((m) => m === 'speech.dictation.finish')).toHaveLength(2)
    expect(methodsOf(sent)).not.toContain('speech.dictation.cancel')
    expect(transcripts).toEqual(['hello world'])
    expect(errors).toEqual([])
  })

  it('holds a chunk refused while recovery dials a replacement, and sends it once connected', async () => {
    let state: ConnectionState = 'connected'
    const rpc = createFakeRpcClient({ getState: () => state })
    const sent: SentRequest[] = []
    const transcripts: string[] = []
    const errors: string[] = []
    mount(rpc, transcripts, errors)

    state = 'disconnected'
    // The OTA page sees the shell's error rebuilt as another class with the same message.
    await record(rpc, sent, [new Error('Client suspended')])
    expect(methodsOf(sent).filter((m) => m === 'speech.dictation.chunk')).toHaveLength(1)
    await act(async () => {
      state = 'connected'
      rpc.pushState('connected')
      await pump(rpc, sent, [])
    })

    expect(methodsOf(sent).filter((m) => m === 'speech.dictation.chunk')).toHaveLength(2)
    expect(dictation().status).toBe('recording')
    expect(errors).toEqual([])
  })

  it('keeps what was transcribed when the connection does not come back', async () => {
    const rpc = createFakeRpcClient()
    const sent: SentRequest[] = []
    const transcripts: string[] = []
    const errors: string[] = []
    mount(rpc, transcripts, errors)

    await record(rpc, sent, [{ text: 'hello' }, new Error('Connection closed')])

    expect(transcripts).toEqual(['hello'])
    expect(errors).toEqual(['Connection closed'])
  })
})

describe('the text so far', () => {
  it('shows what the host heard while recording and clears it as the final text lands', async () => {
    const rpc = createFakeRpcClient()
    const sent: SentRequest[] = []
    const transcripts: string[] = []
    mount(rpc, transcripts, [])

    await record(rpc, sent, [{ text: 'hello' }, {}, { text: 'hello wor' }])
    expect(dictation().transcriptSoFar).toBe('hello wor')

    await act(async () => {
      const stopped = dictation().stop()
      await pump(rpc, sent, [])
      await stopped
    })
    expect(dictation().transcriptSoFar).toBe('')
    expect(transcripts).toEqual(['hello world'])
  })
})
