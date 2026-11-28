import { describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import {
  registerDocumentClientEventsStream,
  subscribeSharedRuntimeClientEvents
} from './shared-runtime-client-events'

const readyResponse: RuntimeRpcResponse<unknown> = {
  ok: true,
  id: 'req-1',
  result: { type: 'ready' },
  _meta: { runtimeId: 'rt-1' }
}

const rowsResponse: RuntimeRpcResponse<unknown> = {
  ok: true,
  id: 'req-1',
  result: { type: 'worktreeRowsChanged' },
  _meta: { runtimeId: 'rt-1' }
}

describe('shared runtime client events', () => {
  it('reuses an active desktop document stream without opening a duplicate upstream subscription', async () => {
    const doc = registerDocumentClientEventsStream('env-shared-1', 1)
    doc.onResponse(readyResponse)

    const openUpstream = vi.fn()
    const received: RuntimeRpcResponse<unknown>[] = []
    const onClose = vi.fn()
    const observer = subscribeSharedRuntimeClientEvents({
      environmentId: 'env-shared-1',
      transportGeneration: 1,
      openUpstream,
      onResponse: (response) => received.push(response),
      onClose
    })

    await Promise.resolve()
    expect(openUpstream).not.toHaveBeenCalled()
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ ok: true, result: { type: 'ready' } })

    doc.onResponse(rowsResponse)
    expect(received).toHaveLength(2)
    expect(received[1]).toBe(rowsResponse)

    observer.close()
    doc.unregister()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('hands off a relay-owned upstream stream to a later desktop document once ready, and promotes on document close', async () => {
    const closeUpstream = vi.fn()
    const captured: {
      callbacks: {
        onResponse: (response: RuntimeRpcResponse<unknown>) => void
        onClose: () => void
      } | null
    } = { callbacks: null }
    const openUpstream = vi.fn(async (callbacks) => {
      captured.callbacks = callbacks
      return { requestId: 'relay-1', close: closeUpstream, sendBinary: () => false }
    })

    const received: RuntimeRpcResponse<unknown>[] = []
    const onClose = vi.fn()
    const observer = subscribeSharedRuntimeClientEvents({
      environmentId: 'env-shared-2',
      transportGeneration: 1,
      openUpstream,
      onResponse: (response) => received.push(response),
      onClose
    })

    expect(openUpstream).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    captured.callbacks?.onResponse(readyResponse)
    expect(received).toHaveLength(1)

    // Desktop document opens later: relay stream closes once document stream is ready.
    const doc = registerDocumentClientEventsStream('env-shared-2', 1)
    expect(closeUpstream).not.toHaveBeenCalled()
    doc.onResponse(readyResponse)
    expect(closeUpstream).toHaveBeenCalledTimes(1)

    doc.onResponse(rowsResponse)
    expect(received.at(-1)).toBe(rowsResponse)

    // Closing the document promotes back to a single relay-owned stream while observer remains.
    doc.unregister()
    expect(openUpstream).toHaveBeenCalledTimes(2)
    expect(onClose).not.toHaveBeenCalled()

    // Closing the last observer closes the promoted relay stream.
    await Promise.resolve()
    observer.close()
    expect(closeUpstream).toHaveBeenCalledTimes(2)
  })

  it('feeds observers from one ready document stream when two windows watch the same server', async () => {
    const first = registerDocumentClientEventsStream('env-shared-3', 1)
    const second = registerDocumentClientEventsStream('env-shared-3', 1)
    first.onResponse(readyResponse)
    second.onResponse(readyResponse)
    const openUpstream = vi.fn()
    const received: RuntimeRpcResponse<unknown>[] = []
    const observer = subscribeSharedRuntimeClientEvents({
      environmentId: 'env-shared-3',
      transportGeneration: 1,
      openUpstream,
      onResponse: (response) => received.push(response),
      onClose: vi.fn()
    })
    await Promise.resolve()
    first.onResponse(rowsResponse)
    second.onResponse(rowsResponse)
    expect(received).toEqual([readyResponse, rowsResponse])

    // The remaining ready window takes over when the feeding one goes away.
    first.unregister()
    second.onResponse(rowsResponse)
    expect(received).toEqual([readyResponse, rowsResponse, rowsResponse])
    expect(openUpstream).not.toHaveBeenCalled()

    observer.close()
    second.unregister()
  })

  it('reopens its own stream instead of closing observers when the only document socket closes', async () => {
    const doc = registerDocumentClientEventsStream('env-shared-4', 1)
    doc.onResponse(readyResponse)
    const openUpstream = vi.fn(async () => ({
      requestId: 'relay-4',
      close: vi.fn(),
      sendBinary: () => false
    }))
    const onClose = vi.fn()
    const observer = subscribeSharedRuntimeClientEvents({
      environmentId: 'env-shared-4',
      transportGeneration: 1,
      openUpstream,
      onResponse: vi.fn(),
      onClose
    })
    doc.onTransportClose()
    expect(openUpstream).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
    await Promise.resolve()
    observer.close()
  })

  it('keeps delivering to other observers when one observer throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const doc = registerDocumentClientEventsStream('env-shared-5', 1)
    doc.onResponse(readyResponse)
    const received: RuntimeRpcResponse<unknown>[] = []
    const throwing = subscribeSharedRuntimeClientEvents({
      environmentId: 'env-shared-5',
      transportGeneration: 1,
      openUpstream: vi.fn(),
      onResponse: () => {
        throw new Error('boom')
      },
      onClose: vi.fn()
    })
    const healthy = subscribeSharedRuntimeClientEvents({
      environmentId: 'env-shared-5',
      transportGeneration: 1,
      openUpstream: vi.fn(),
      onResponse: (response) => received.push(response),
      onClose: vi.fn()
    })
    await Promise.resolve()
    doc.onResponse(rowsResponse)
    expect(received).toEqual([readyResponse, rowsResponse])
    throwing.close()
    healthy.close()
    doc.unregister()
    warn.mockRestore()
  })
})
