import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcClientConnectionState } from '../transport/rpc-client-connection-state'
import { RpcClientRequestTracker } from '../transport/rpc-client-request-tracker'
import type { RpcRequestFrame } from '../transport/rpc-envelope-fields'
import { saveMobileClipboardImageAsTempFile } from './mobile-clipboard-image'

function uploadTransport() {
  const state = new RpcClientConnectionState({
    endpoint: 'ws://desktop.invalid',
    getReconnectAttempt: () => 0,
    isClosed: () => false
  })
  const frames: RpcRequestFrame[] = []
  let id = 0
  const requests = new RpcClientRequestTracker({
    nextId: () => String(++id),
    getState: () => state.get(),
    waitForConnected: (timeoutMs) => state.waitForConnected(timeoutMs),
    sendFrame: (frame) => {
      frames.push(frame)
      return true
    }
  })
  return {
    state,
    frames,
    client: { sendRequest: requests.sendRequest.bind(requests) },
    reply: (index: number, result: unknown) => {
      const frame = frames[index]
      if (!frame) {
        throw new Error('Request not sent')
      }
      requests.resolve({ id: frame.id, ok: true, result })
    },
    fail: (index: number) => {
      const frame = frames[index]
      if (!frame) {
        throw new Error('Request not sent')
      }
      requests.resolve({ id: frame.id, ok: false, error: { code: 'refused', message: 'No space' } })
    }
  }
}

describe('clipboard image network deadline', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('allows a brief reconnect before staging an image, then completes the upload', async () => {
    const transport = uploadTransport()
    const pending = saveMobileClipboardImageAsTempFile(transport.client, 'aGVsbG8=', {
      deadline: Date.now() + 30_000
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(transport.frames).toEqual([])
    transport.state.publish('connected')
    await vi.advanceTimersByTimeAsync(0)
    transport.reply(0, { uploadId: 'slot' })
    await vi.advanceTimersByTimeAsync(0)
    transport.reply(1, { receivedBase64Length: 8 })
    await vi.advanceTimersByTimeAsync(0)
    transport.reply(2, '/tmp/paste.png')
    await expect(pending).resolves.toBe('/tmp/paste.png')
  })

  it('ends a disconnected upload within its budget and never stages after a later reconnect', async () => {
    const transport = uploadTransport()
    const result = saveMobileClipboardImageAsTempFile(transport.client, 'aGVsbG8=', {
      deadline: Date.now() + 30_000
    }).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await result).toEqual(
      new Error('Timed out while connecting to the remote Orca runtime.')
    )
    transport.state.publish('connected')
    await vi.advanceTimersByTimeAsync(0)
    expect(transport.frames).toEqual([])
  })

  it('shares one deadline across upload legs and bounds cleanup to one extra second', async () => {
    const transport = uploadTransport()
    transport.state.publish('connected')
    const result = saveMobileClipboardImageAsTempFile(transport.client, 'aGVsbG8=', {
      deadline: Date.now() + 30_000
    }).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(20_000)
    transport.reply(0, { uploadId: 'slot' })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(transport.frames.map((frame) => frame.method)).toEqual([
      'clipboard.startImageUpload',
      'clipboard.appendImageUploadChunk'
    ])
    await vi.advanceTimersByTimeAsync(1_001)
    expect(await result).toEqual(new Error('Request timed out: clipboard.appendImageUploadChunk'))
    expect(transport.frames.map((frame) => frame.method)).toEqual([
      'clipboard.startImageUpload',
      'clipboard.appendImageUploadChunk',
      'clipboard.abortImageUpload'
    ])
  })

  it('does not let abort park the original error behind a reconnect', async () => {
    const transport = uploadTransport()
    transport.state.publish('connected')
    const result = saveMobileClipboardImageAsTempFile(transport.client, 'aGVsbG8=', {
      deadline: Date.now() + 30_000
    }).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    transport.reply(0, { uploadId: 'slot' })
    await vi.advanceTimersByTimeAsync(0)
    transport.state.publish('reconnecting')
    transport.fail(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(await result).toEqual(new Error('No space'))
    transport.state.publish('connected')
    await vi.advanceTimersByTimeAsync(0)
    expect(transport.frames).toHaveLength(2)
  })
})
