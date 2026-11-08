// Each chunk RPC holds a page bridge desktop slot until the host answers, through a reconnect too; a stalled link must not take one per page drain.
import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import {
  createFakeRpcClient,
  type FakeRpcClient,
  type SentRequest
} from '../mobile-web-shell/bridge-host-test-fakes'
import type {
  DictationCapture,
  DictationCaptureChunk
} from '../platform/dictation-capture-contract'

const chunkHandlers = vi.hoisted(() => new Set<(chunk: DictationCaptureChunk) => void>())

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
      chunkHandlers.add(handler)
      return { remove: () => chunkHandlers.delete(handler) }
    },
    onInterruption: () => ({ remove: () => {} })
  }
  return { useDictationCapture: () => capture }
})

import { useMobileDictation, type UseMobileDictationResult } from './use-mobile-dictation'

function chunkRequests(rpc: FakeRpcClient): SentRequest[] {
  return rpc.requests.filter((request) => request.method === 'speech.dictation.chunk')
}

function paramsOf(request: SentRequest): { audioBase64: string; seq: number } {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: chunk requests carry DictationChunk params.
  return request.args[1] as { audioBase64: string; seq: number }
}

async function answer(rpc: FakeRpcClient, requests: SentRequest[], text: string): Promise<void> {
  for (const request of requests) {
    rpc.requests.splice(rpc.requests.indexOf(request), 1)
    request.resolve({
      id: 'desktop',
      ok: true,
      result: request.method === 'speech.dictation.finish' ? { text } : {}
    })
  }
  for (let round = 0; round < 8; round += 1) {
    await Promise.resolve()
  }
}

async function startDictation(rpc: FakeRpcClient, transcripts: string[] = []) {
  const held: { dictation: UseMobileDictationResult | null } = { dictation: null }
  function Probe(): null {
    held.dictation = useMobileDictation({
      client: rpc,
      enabled: true,
      onTranscript: (text) => transcripts.push(text),
      onError: () => {}
    })
    return null
  }
  act(() => {
    create(createElement(Probe))
  })
  await act(async () => {
    const started = held.dictation!.start()
    for (let round = 0; round < 4; round += 1) {
      await answer(rpc, [...rpc.requests], '')
    }
    await started
  })
  return () => held.dictation!
}

function speak(count: number): void {
  act(() => {
    for (let index = 0; index < count; index += 1) {
      for (const handler of chunkHandlers) {
        handler({ data: Uint8Array.from([index, index]), droppedBytes: 0 })
      }
    }
  })
}

describe('phone dictation chunks on a link that stops answering', () => {
  it('keep four requests waiting, then send the audio captured meanwhile as one, before the finish', async () => {
    const rpc = createFakeRpcClient()
    const transcripts: string[] = []
    const dictation = await startDictation(rpc, transcripts)

    speak(10)
    const waiting = chunkRequests(rpc)
    expect(waiting.map((request) => paramsOf(request).seq)).toEqual([0, 1, 2, 3])

    let stopped: Promise<void> = Promise.resolve()
    await act(async () => {
      stopped = dictation().stop()
      await answer(rpc, waiting, '')
    })
    // Six held two-byte captures, merged into one request after the first that came free.
    const merged = chunkRequests(rpc)
    expect(merged.map(paramsOf)).toEqual([
      { ...paramsOf(merged[0]), seq: 4, audioBase64: 'BAQFBQYGBwcICAkJ' }
    ])
    expect(rpc.requests.some((request) => request.method === 'speech.dictation.finish')).toBe(false)

    await act(async () => {
      await answer(rpc, merged, '')
      await answer(rpc, [...rpc.requests], 'all ten')
      await stopped
    })
    expect(transcripts).toEqual(['all ten'])
  })

  it('keep the newest text so far when an older reply arrives last', async () => {
    const rpc = createFakeRpcClient()
    const dictation = await startDictation(rpc)
    speak(2)
    const [older, newer] = chunkRequests(rpc)
    const reply = (request: SentRequest, result: { text: string; revision: number }) => {
      rpc.requests.splice(rpc.requests.indexOf(request), 1)
      request.resolve({ id: 'desktop', ok: true, result })
    }
    await act(async () => {
      reply(newer, { text: 'open the file', revision: 2 })
      reply(older, { text: 'open', revision: 1 })
      for (let round = 0; round < 8; round += 1) {
        await Promise.resolve()
      }
    })
    expect(dictation().transcriptSoFar).toBe('open the file')
  })
})
