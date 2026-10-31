import { expect, it, vi } from 'vitest'
import { createMobileChatAttachmentReader } from './mobile-chat-attachment-read'
import { AttachmentTextSource } from '../../../src/shared/attachment-text-source'
import { AGENT_SESSION_TEXT_ATTACHMENT_READ_CAPABILITY } from '../../../src/shared/agent-session-runtime-capabilities'
import { RpcClientRequestTracker } from '../transport/rpc-client-request-tracker'
import { RpcClientConnectionState } from '../transport/rpc-client-connection-state'
import { createStableLogicalRpcClient } from '../transport/stable-logical-rpc-client'
import { scopeRpcClientToExecutionHost } from '../transport/execution-host-scoped-rpc-client'
import type { SendRequestOptions } from '../transport/rpc-client'
import type { RpcRequestFrame } from '../transport/rpc-envelope-fields'
import { createFakeBridgePortPair } from '../mobile-web-shell/bridge/bridge-port-pair-test-harness'
import { BridgeReplyAssembler } from '../mobile-web-shell/bridge/bridge-reply-chunking'
import { INIT } from '../mobile-web-shell/bridge/bridge-page-client-test-harness'
import { readBridgeHostMessage } from '../mobile-web-shell/bridge/bridge-envelope'

function fixture() {
  const state = new RpcClientConnectionState({
    endpoint: 'ws://test35636',
    getReconnectAttempt: () => 0,
    isClosed: () => false
  })
  state.publish('connected')
  const frames: RpcRequestFrame[] = []
  const control: {
    capable: boolean
    holdStatus: boolean
    holdBody: boolean
    atConnected: (() => void) | undefined
    body: unknown
  } = {
    capable: true,
    holdStatus: false,
    holdBody: false,
    atConnected: undefined,
    body: {
      snapshot: 'a'.repeat(64),
      size: 1,
      bytesRead: 1,
      contentBase64: 'eA==',
      eof: true
    }
  }
  let serial = 0
  let currentMethod = ''
  const answer = (frame: RpcRequestFrame, runtimeId = 'successor') =>
    tracker.resolve({
      id: frame.id,
      ok: true,
      result:
        frame.method === 'status.get'
          ? { capabilities: control.capable ? [AGENT_SESSION_TEXT_ATTACHMENT_READ_CAPABILITY] : [] }
          : control.body,
      _meta: { runtimeId }
    })
  const tracker = new RpcClientRequestTracker({
    nextId: () => String(++serial),
    getState: () => state.get(),
    waitForConnected: (timeout) => {
      const connected = state.waitForConnected(timeout)
      return currentMethod === 'agentSessionAttachment.readTextChunk' && control.atConnected
        ? connected.then(control.atConnected)
        : connected
    },
    sendFrame: (frame) => {
      frames.push(frame)
      if (!(frame.method === 'status.get' ? control.holdStatus : control.holdBody)) {
        queueMicrotask(() => answer(frame))
      }
      return true
    }
  })
  const physical = {
    sendRequest: (method: string, params?: unknown, options?: SendRequestOptions) => {
      currentMethod = method
      return tracker.sendRequest(method, params, options)
    },
    getState: () => state.get(),
    getLastConnectedAt: () => state.getLastConnectedAt(),
    getReconnectAttempt: () => 0,
    onStateChange: (listener: Parameters<typeof state.addListener>[0]) =>
      state.addListener(listener),
    notifyForeground: () => {},
    close: () => tracker.rejectAll('closed'),
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {}
  }
  const logical = createStableLogicalRpcClient(physical, 'lan')
  const client = scopeRpcClientToExecutionHost(logical, 'runtime:server35636')
  const source = (read = createMobileChatAttachmentReader(client)) =>
    new AttachmentTextSource('/source35636', read)
  const bodyCount = () =>
    frames.filter((frame) => frame.method === 'agentSessionAttachment.readTextChunk').length
  return { state, frames, control, answer, tracker, physical, logical, client, source, bodyCount }
}

it.each([1, 10])(
  'settles %s abandoned status waiters before release and keeps same-reader successors pinned',
  async (count) => {
    const f = fixture()
    f.control.holdStatus = true
    const readers = Array.from({ length: count }, () => createMobileChatAttachmentReader(f.client))
    const old = readers.map(f.source)
    const pending = old.map((source) => source.page(0).catch((error) => error))
    await vi.waitFor(() => expect(f.frames).toHaveLength(count))
    const held = [...f.frames]
    old.forEach((source) => source.dispose())
    expect((await Promise.all(pending)).map((error) => error.name)).toEqual(
      Array(count).fill('AbortError')
    )
    expect(f.tracker.size()).toBe(0)
    f.control.holdStatus = false
    const successors = readers.map(f.source)
    await Promise.all(successors.map((source) => source.page(0)))
    expect(f.bodyCount()).toBe(count)
    held.forEach((frame) => expect(f.answer(frame, 'disposed')).toBe(false))
    expect(f.bodyCount()).toBe(count)
    expect(await Promise.all(successors.map((source) => source.copyText()))).toEqual(
      Array(count).fill('x')
    )
    expect(f.frames.every((frame) => !('signal' in frame) && !('beforeSend' in frame))).toBe(true)
    expect(
      f.frames.every(
        (frame) =>
          JSON.stringify(frame.envelope) ===
          JSON.stringify({ executionHost: 'runtime:server35636' })
      )
    ).toBe(true)
    successors.forEach((source) => source.dispose())
    f.logical.close()
  }
)

it('preserves old-host Retry, malformed reply refusal, final-send ownership and reconnect through the real client', async () => {
  const f = fixture()
  const read = createMobileChatAttachmentReader(f.client)
  f.control.capable = false
  await expect(f.source(read).page(0)).rejects.toThrow('cannot open text attachments yet')
  expect(f.frames.map((frame) => frame.method)).toEqual(['status.get'])
  f.control.capable = true
  expect(await f.source(read).copyText()).toBe('x')
  const old = f.source(read)
  f.control.atConnected = () => {
    f.control.atConnected = undefined
    old.dispose()
  }
  const before = f.bodyCount()
  await expect(old.copyText()).rejects.toMatchObject({ name: 'AbortError' })
  expect(f.bodyCount()).toBe(before)
  const retry = f.source(read)
  expect(await retry.copyText()).toBe('x')
  f.control.atConnected = () => {
    f.control.atConnected = undefined
    return f.logical.migrateTo({ ...f.physical }, 'lan')
  }
  const beforeMigration = f.bodyCount()
  await expect(f.source(read).copyText()).rejects.toThrow('RPC interrupted by connection migration')
  expect(f.bodyCount()).toBe(beforeMigration)
  await expect(retry.copyText()).rejects.toThrow('Connection changed')
  f.control.atConnected = () => {
    f.control.atConnected = undefined
    f.state.publish('disconnected')
  }
  await expect(f.source().copyText()).rejects.toThrow('Not connected')
  expect(f.bodyCount()).toBe(beforeMigration)
  f.state.publish('connected')
  expect(await f.source().copyText()).toBe('x')
  f.control.body = { contentBase64: 'a' }
  await expect(f.source().page(0)).rejects.toThrow()
  f.control.holdBody = true
  const admitted = f.source()
  const pending = admitted.copyText().catch((error) => error)
  await vi.waitFor(() => expect(f.tracker.size()).toBe(1))
  const late = f.frames.at(-1)!
  admitted.dispose()
  expect((await pending).name).toBe('AbortError')
  expect(f.tracker.size()).toBe(0)
  expect(f.answer(late)).toBe(false)
  retry.dispose()
  f.logical.close()
})

it.each(['abort', 'deadline'] as const)(
  'runs real source/reader/bridge assembly through %s and same-reader Retry',
  async (end) => {
    vi.useFakeTimers()
    const held: string[] = []
    let holdId: string | undefined
    let capable = true
    let runtimeId = 'runtime-a'
    const bytes = Buffer.from('original line with @"raw path"\n'.repeat(20_000))
    const pair = createFakeBridgePortPair({
      holdToPage: (json) => {
        const frame = readBridgeHostMessage(json)
        if (frame.ok && frame.message.type === 'reply' && frame.message.id === holdId) {
          held.push(json)
          return true
        }
        return false
      }
    })
    const accept = vi.spyOn(BridgeReplyAssembler.prototype, 'accept')
    let answered = 0
    const answerNext = () => {
      const request = pair.rpc.requests[answered++]
      if (!request) {
        throw new Error('no physical request to answer')
      }
      let result: unknown = {
        capabilities: capable ? [AGENT_SESSION_TEXT_ATTACHMENT_READ_CAPABILITY] : []
      }
      if (request.method === 'agentSessionAttachment.readTextChunk') {
        const params = request.args[1]
        if (
          !params ||
          typeof params !== 'object' ||
          !('path' in params) ||
          !('offset' in params) ||
          !('length' in params) ||
          typeof params.offset !== 'number' ||
          typeof params.length !== 'number'
        ) {
          throw new Error('invalid real range request')
        }
        expect(params.path).toBe('/original-source35636')
        const content = bytes.subarray(params.offset, params.offset + params.length)
        result = {
          snapshot: 'a'.repeat(64),
          size: bytes.length,
          contentBase64: content.toString('base64'),
          bytesRead: content.length,
          eof: params.offset + content.length === bytes.length
        }
      }
      request.resolve({ id: `host${answered}`, ok: true, result, _meta: { runtimeId } })
    }
    const serve = async () => {
      for (let turn = 0; turn < 24; turn++) {
        await pair.flush()
        while (answered < pair.rpc.requests.length) {
          answerNext()
        }
      }
      await pair.flush()
    }
    try {
      await pair.flush()
      const read = createMobileChatAttachmentReader(pair.client)
      const source = () => new AttachmentTextSource('/original-source35636', read)
      const a = source()
      const abandoned = a.page(0).catch((error: unknown) => error)
      await pair.flush()
      answerNext() // Real typed status admission precedes the body request.
      await pair.flush()
      const frame = pair.readToShell().findLast((message) => message.type === 'request')
      if (frame?.type !== 'request') {
        throw new Error('missing body frame')
      }
      holdId = frame.id
      answerNext()
      await pair.flush()
      const whole = readBridgeHostMessage(held[0]!)
      if (!whole.ok || whole.message.type !== 'reply' || !('payload' in whole.message)) {
        throw new Error('missing held reply')
      }
      const serialized = JSON.stringify(whole.message.payload)
      const split = Math.floor(serialized.length / 2)
      const parts = [serialized.slice(0, split), serialized.slice(split)].map((chunk, i) =>
        JSON.stringify({ v: 1, type: 'reply', id: holdId, part: { i, of: 2 }, chunk })
      )
      pair.deliverToPage(parts[0]!)
      expect(accept.mock.results.at(-1)?.value).toEqual({ status: 'pending' })
      if (end === 'deadline') {
        await vi.advanceTimersByTimeAsync(1_000)
      }
      const b = source()
      const bOutput = b.copyText()
      await pair.flush()
      if (end === 'abort') {
        a.dispose()
      } else {
        await vi.advanceTimersByTimeAsync(14_001)
      }
      expect(await abandoned).toBeInstanceOf(Error)
      expect(a.snapshot).toBeUndefined()
      expect(a.size).toBeNull()
      await pair.flush()
      expect(
        pair.readToShell().some((message) => message.type === 'cancel' && message.id === holdId)
      ).toBe(true)
      pair.deliverToPage(parts[1]!)
      pair.deliverToPage(parts[0]!) // An unsolicited old first part must also discard itself.
      holdId = undefined
      await serve()
      expect(await bOutput).toBe(bytes.toString())
      expect(a.snapshot).toBeUndefined()
      a.dispose()
      const reopened = source()
      const output = reopened.copyText()
      await serve()
      expect(await output).toBe(bytes.toString())
      expect(reopened.snapshot).toBe('a'.repeat(64))
      const beforePages = pair.rpc.requests.filter(
        (request) => request.method === 'agentSessionAttachment.readTextChunk'
      ).length
      for (const page of [0, 1, 2, 0]) {
        const view = reopened.page(page)
        await serve()
        expect((await view).segments.length).toBeLessThanOrEqual(256)
      }
      expect(
        pair.rpc.requests.filter(
          (request) => request.method === 'agentSessionAttachment.readTextChunk'
        )
      ).toHaveLength(beforePages + 4)
      // Real status refusal, then the same reader's legitimate Retry with the authoritative shared scalar.
      capable = false
      const before = pair.rpc.requests.filter(
        (request) => request.method === 'agentSessionAttachment.readTextChunk'
      ).length
      const unsupported = source()
        .page(0)
        .catch((error: unknown) => error)
      await serve()
      expect(await unsupported).toMatchObject({
        message: expect.stringContaining('cannot open text attachments yet')
      })
      expect(
        pair.rpc.requests.filter(
          (request) => request.method === 'agentSessionAttachment.readTextChunk'
        )
      ).toHaveLength(before)
      capable = true
      const retry = source()
      const retryOutput = retry.copyText()
      await serve()
      expect(await retryOutput).toBe(bytes.toString())
      runtimeId = 'replacement-runtime'
      const stale = reopened.page(1).catch((error: unknown) => error)
      await serve()
      expect(await stale).toMatchObject({ message: expect.stringContaining('host changed') })
      expect(reopened.snapshot).toBe('a'.repeat(64))
      expect(reopened.size).toBe(bytes.length)
      const closed = source()
        .page(0)
        .catch((error: unknown) => error)
      await pair.flush()
      pair.deliverToPage(JSON.stringify({ ...INIT, sessionId: 'replacement-shell' }))
      await serve()
      expect(await closed).toMatchObject({ name: 'BridgeShellReplacedError' })
      const replacement = new AttachmentTextSource(
        '/original-source35636',
        createMobileChatAttachmentReader(pair.client)
      )
      const replacementOutput = replacement.copyText()
      await serve()
      expect(await replacementOutput).toBe(bytes.toString())
      replacement.dispose()
      b.dispose()
      reopened.dispose()
      retry.dispose()
    } finally {
      pair.client.close()
      pair.host.dispose()
      vi.restoreAllMocks()
      vi.useRealTimers()
    }
  }
)
