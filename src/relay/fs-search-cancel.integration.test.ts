import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { fakeSearchWithRg } = vi.hoisted(() => {
  type SearchResult = {
    files: unknown[]
    totalMatches: number
    truncated: boolean
  }
  type SearchRecord = {
    signal: AbortSignal | undefined
    resolve: (result: SearchResult) => void
  }
  const searches: SearchRecord[] = []
  const fakeSearchWithRg = Object.assign(
    vi.fn(
      (
        _rootPath: string,
        _query: string,
        _options: Record<string, unknown>,
        signal?: AbortSignal
      ) =>
        new Promise<SearchResult>((resolve, reject) => {
          searches.push({ signal, resolve })
          signal?.addEventListener(
            'abort',
            () =>
              reject(
                signal.reason instanceof Error ? signal.reason : new Error('Search cancelled')
              ),
            { once: true }
          )
        })
    ),
    { searches }
  )
  return { fakeSearchWithRg }
})

vi.mock('./fs-handler-utils', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>
  return {
    ...original,
    checkRgAvailable: () => Promise.resolve(true),
    searchWithRg: fakeSearchWithRg
  }
})

import {
  SshChannelMultiplexer,
  type MultiplexerTransport
} from '../main/ssh/ssh-channel-multiplexer'
import {
  FrameDecoder,
  MessageType,
  parseJsonRpcMessage,
  type JsonRpcMessage
} from '../main/ssh/relay-protocol'
import { RelayContext } from './context'
import { RelayDispatcher } from './dispatcher'
import { FsHandler } from './fs-handler'

const SEARCH_PARAMS = {
  query: 'needle',
  rootPath: '/workspace',
  caseSensitive: false,
  wholeWord: false,
  useRegex: false,
  maxResults: 100
}

const SEARCH_RESULT = {
  files: [],
  totalMatches: 0,
  truncated: false
}

async function flushPipe(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

describe('Integration: cancellable fs.search', () => {
  let mux: SshChannelMultiplexer
  let dispatcher: RelayDispatcher
  let fsHandler: FsHandler
  let clientMessages: JsonRpcMessage[]

  beforeEach(() => {
    fakeSearchWithRg.mockClear()
    fakeSearchWithRg.searches.length = 0
    clientMessages = []

    let relayFeed: (data: Buffer) => void
    const clientDataCallbacks: ((data: Buffer) => void)[] = []
    const clientFrameDecoder = new FrameDecoder((frame) => {
      if (frame.type === MessageType.Regular) {
        clientMessages.push(parseJsonRpcMessage(frame.payload))
      }
    })
    const clientTransport: MultiplexerTransport = {
      write: (data) => {
        clientFrameDecoder.feed(data)
        setImmediate(() => relayFeed(data))
      },
      onData: (callback) => clientDataCallbacks.push(callback),
      onClose: () => {}
    }
    dispatcher = new RelayDispatcher((data) => {
      setImmediate(() => {
        for (const callback of clientDataCallbacks) {
          callback(data)
        }
      })
    })
    relayFeed = (data) => dispatcher.feed(data)
    fsHandler = new FsHandler(dispatcher, new RelayContext())
    mux = new SshChannelMultiplexer(clientTransport)
  })

  afterEach(() => {
    mux.dispose()
    dispatcher.dispose()
    fsHandler.dispose()
  })

  it('propagates client cancellation to the relay search signal', async () => {
    const controller = new AbortController()
    const searchPromise = mux.request('fs.search', SEARCH_PARAMS, { signal: controller.signal })
    await flushPipe()

    expect(fakeSearchWithRg.searches).toHaveLength(1)
    expect(fakeSearchWithRg.searches[0].signal?.aborted).toBe(false)

    controller.abort()
    await expect(searchPromise).rejects.toThrow('was cancelled')
    await flushPipe()

    const searchRequest = clientMessages.find(
      (message) => 'method' in message && message.method === 'fs.search'
    ) as { id: number } | undefined
    expect(searchRequest?.id).toEqual(expect.any(Number))
    expect(clientMessages).toContainEqual({
      jsonrpc: '2.0',
      method: 'rpc.cancel',
      params: { id: searchRequest?.id }
    })
    expect(fakeSearchWithRg.searches[0].signal?.aborted).toBe(true)
  })

  it('returns a completed search result without cancellation', async () => {
    const searchPromise = mux.request('fs.search', SEARCH_PARAMS)
    await flushPipe()

    expect(fakeSearchWithRg).toHaveBeenCalledWith(
      '/workspace',
      'needle',
      expect.objectContaining({ maxResults: 100 }),
      expect.any(AbortSignal)
    )
    fakeSearchWithRg.searches[0].resolve(SEARCH_RESULT)

    await expect(searchPromise).resolves.toEqual(SEARCH_RESULT)
    expect(fakeSearchWithRg.searches[0].signal?.aborted).toBe(false)
  })
})
