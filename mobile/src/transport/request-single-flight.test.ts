import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from './rpc-client'
import type { RpcResponse } from './types'
import { sendSingleFlightRequest } from './request-single-flight'

function makeResponse(id: string): RpcResponse {
  return { id, ok: true, result: {}, _meta: { runtimeId: 'runtime-1' } }
}

const response = makeResponse('request-1')

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
  it('coalesces triggers that arrive during an in-flight read into one trailing follow-up', async () => {
    const leading = deferred<RpcResponse>()
    const trailing = deferred<RpcResponse>()
    const leadingResponse = makeResponse('leading')
    const trailingResponse = makeResponse('trailing')
    const sendRequest = vi
      .fn<() => Promise<RpcResponse>>()
      .mockReturnValueOnce(leading.promise)
      .mockReturnValueOnce(trailing.promise)
    const client = rpcClient(sendRequest)

    const first = sendSingleFlightRequest(client, 'host-1', 'worktree.ps', { limit: 10000 })
    // Two more triggers arrive while the read is on the wire: no duplicate now, and they share ONE
    // trailing follow-up (not the older in-flight response).
    const second = sendSingleFlightRequest(client, 'host-1', 'worktree.ps', { limit: 10000 })
    const third = sendSingleFlightRequest(client, 'host-1', 'worktree.ps', { limit: 10000 })

    expect(second).toBe(third)
    expect(second).not.toBe(first)
    expect(sendRequest).toHaveBeenCalledTimes(1)

    leading.resolve(leadingResponse)
    expect(await first).toBe(leadingResponse)

    // The leading read settled → the coalesced follow-up fires exactly once.
    expect(sendRequest).toHaveBeenCalledTimes(2)
    trailing.resolve(trailingResponse)
    expect(await second).toBe(trailingResponse)
    expect(await third).toBe(trailingResponse)
  })

  it('starts a fresh request once nothing is in flight', async () => {
    const leading = deferred<RpcResponse>()
    const sendRequest = vi
      .fn<() => Promise<RpcResponse>>()
      .mockReturnValueOnce(leading.promise)
      .mockResolvedValueOnce(response)
    const client = rpcClient(sendRequest)

    const first = sendSingleFlightRequest(client, 'host-1', 'worktree.ps', { limit: 10000 })
    leading.resolve(response)
    await first

    const next = sendSingleFlightRequest(client, 'host-1', 'worktree.ps', { limit: 10000 })
    expect(next).not.toBe(first)
    expect(sendRequest).toHaveBeenCalledTimes(2)
    await next
  })

  it('rejects the leading caller on failure but still runs a queued follow-up', async () => {
    const leading = deferred<RpcResponse>()
    const failure = new Error('request failed')
    const sendRequest = vi
      .fn<() => Promise<RpcResponse>>()
      .mockReturnValueOnce(leading.promise)
      .mockResolvedValueOnce(response)
    const client = rpcClient(sendRequest)

    const first = sendSingleFlightRequest(client, 'host-1', 'accounts.list')
    const second = sendSingleFlightRequest(client, 'host-1', 'accounts.list')

    leading.reject(failure)
    await expect(first).rejects.toBe(failure)
    // A trigger that arrived mid-flight is not poisoned by the leading failure: its follow-up runs.
    await expect(second).resolves.toBe(response)
    expect(sendRequest).toHaveBeenCalledTimes(2)
  })

  it('clears a failed leading request so the next call retries', async () => {
    const failure = new Error('request failed')
    const sendRequest = vi
      .fn<() => Promise<RpcResponse>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(response)
    const client = rpcClient(sendRequest)

    await expect(sendSingleFlightRequest(client, 'host-1', 'accounts.list')).rejects.toBe(failure)
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
