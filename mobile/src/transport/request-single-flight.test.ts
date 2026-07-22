import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from './rpc-client'
import type { RpcResponse } from './types'
import { sendSingleFlightRequest } from './request-single-flight'

const response: RpcResponse = {
  id: 'request-1',
  ok: true,
  result: {},
  _meta: { runtimeId: 'runtime-1' }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function rpcClient(sendRequest: RpcClient['sendRequest']): RpcClient {
  return { sendRequest } as RpcClient
}

describe('sendSingleFlightRequest', () => {
  it('shares a concurrent request and clears it after success', async () => {
    const pending = deferred<RpcResponse>()
    const sendRequest = vi
      .fn<() => Promise<RpcResponse>>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(response)
    const client = rpcClient(sendRequest)

    const first = sendSingleFlightRequest(client, 'host-1', 'worktree.ps', { limit: 10000 })
    const second = sendSingleFlightRequest(client, 'host-1', 'worktree.ps', { limit: 10000 })

    expect(second).toBe(first)
    expect(sendRequest).toHaveBeenCalledTimes(1)

    pending.resolve(response)
    await first
    const next = sendSingleFlightRequest(client, 'host-1', 'worktree.ps', { limit: 10000 })

    expect(next).not.toBe(first)
    expect(sendRequest).toHaveBeenCalledTimes(2)
    await next
  })

  it('propagates a shared failure and clears it for retry', async () => {
    const pending = deferred<RpcResponse>()
    const failure = new Error('request failed')
    const sendRequest = vi
      .fn<() => Promise<RpcResponse>>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(response)
    const client = rpcClient(sendRequest)
    const first = sendSingleFlightRequest(client, 'host-1', 'accounts.list')
    const second = sendSingleFlightRequest(client, 'host-1', 'accounts.list')

    pending.reject(failure)
    await Promise.all([expect(first).rejects.toBe(failure), expect(second).rejects.toBe(failure)])

    await expect(sendSingleFlightRequest(client, 'host-1', 'accounts.list')).resolves.toBe(response)
    expect(sendRequest).toHaveBeenCalledTimes(2)
  })

  it('does not share requests across clients, hosts, or request kinds', async () => {
    const pending = deferred<RpcResponse>()
    const firstSend = vi.fn(() => pending.promise)
    const secondSend = vi.fn(() => pending.promise)
    const firstClient = rpcClient(firstSend)
    const secondClient = rpcClient(secondSend)

    const requests = [
      sendSingleFlightRequest(firstClient, 'host-1', 'settings.get'),
      sendSingleFlightRequest(firstClient, 'host-2', 'settings.get'),
      sendSingleFlightRequest(firstClient, 'host-1', 'preflight.check'),
      sendSingleFlightRequest(secondClient, 'host-1', 'settings.get')
    ]

    expect(firstSend).toHaveBeenCalledTimes(3)
    expect(secondSend).toHaveBeenCalledTimes(1)
    pending.resolve(response)
    await Promise.all(requests)
  })
})
