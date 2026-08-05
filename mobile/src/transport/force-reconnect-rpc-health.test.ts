import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient, SendRequestOptions } from './rpc-client'
import type { ConnectionState, RpcResponse } from './types'
import { verifyForceReconnectRpcHealth } from './force-reconnect-rpc-health'
import { waitForMobileRelayRpcConnected } from './mobile-relay-rpc-connect-wait'
import { markRpcDeliveryUnknown } from './rpc-delivery-ambiguity'
import {
  createStableLogicalRpcClient,
  LogicalClientCutoverError
} from './stable-logical-rpc-client'
import { RpcApplicationResponsiveness } from './rpc-application-responsiveness'
import { RecoverableRpcError } from './recoverable-rpc-error'

describe('Force Reconnect RPC health', () => {
  afterEach(() => vi.useRealTimers())

  it('spends one 15-second budget across a cutover and the replacement probe', async () => {
    vi.useFakeTimers()
    let attempt = 0
    const timeouts: number[] = []
    const sendRequest = vi.fn(
      (_method: string, _params?: unknown, options?: SendRequestOptions): Promise<never> => {
        const timeoutMs = options?.timeoutMs ?? 0
        timeouts.push(timeoutMs)
        const currentAttempt = ++attempt
        return new Promise((_, reject) => {
          setTimeout(
            () =>
              reject(currentAttempt === 1 ? new LogicalClientCutoverError() : new Error('stalled')),
            currentAttempt === 1 ? 14_000 : timeoutMs
          )
        })
      }
    )
    const client = { sendRequest, getState: () => 'connected' as const } as unknown as RpcClient
    let outcome = 'pending'
    const verification = verifyForceReconnectRpcHealth(client).catch((error: Error) => {
      outcome = error.message
    })

    await vi.advanceTimersByTimeAsync(14_999)
    expect(outcome).toBe('pending')
    expect(timeouts).toEqual([15_000, 1_000])
    await vi.advanceTimersByTimeAsync(1)
    await verification

    expect(outcome).toBe('stalled')
    expect(sendRequest).toHaveBeenCalledTimes(2)
    expect(sendRequest).toHaveBeenLastCalledWith(
      'worktree.ps',
      { limit: 1 },
      {
        timeoutMs: 1_000,
        budgetSpansConnect: true,
        strictDeadline: true,
        applicationHealthProbe: true
      }
    )
  })

  it('waits through a transient authorization retry', async () => {
    let state: ConnectionState = 'connecting'
    const sendRequest = vi.fn<() => Promise<RpcResponse>>()
    sendRequest
      .mockImplementationOnce(async () => {
        state = 'reconnecting'
        throw new Error('Unauthorized — pairing may be revoked')
      })
      .mockImplementationOnce(async () => {
        state = 'connected'
        return { id: 'rpc-1', ok: true, result: {} }
      })
    const client = { sendRequest, getState: () => state } as unknown as RpcClient

    await expect(verifyForceReconnectRpcHealth(client)).resolves.toBeUndefined()

    expect(sendRequest).toHaveBeenCalledTimes(2)
  })

  it('clears the shared latch with an application-level replacement probe', async () => {
    const responsiveness = new RpcApplicationResponsiveness()
    responsiveness.recordTimeout(123)
    const sendRequest = vi.fn(async (method: string) => {
      responsiveness.recordResponse(method)
      return { id: 'rpc-1', ok: true, result: {} } as RpcResponse
    })
    const client = {
      sendRequest,
      getState: () => 'connected' as const,
      getRpcUnresponsiveSince: () => responsiveness.getUnresponsiveSince()
    } as unknown as RpcClient

    await expect(verifyForceReconnectRpcHealth(client)).resolves.toBeUndefined()
    expect(sendRequest).toHaveBeenCalledWith(
      'worktree.ps',
      { limit: 1 },
      expect.objectContaining({ strictDeadline: true })
    )
    expect(responsiveness.getUnresponsiveSince()).toBeNull()
  })

  it('uses an application probe allowed by older desktop hosts', async () => {
    const sendRequest = vi.fn(async (method: string) =>
      method === 'worktree.list'
        ? ({
            id: 'rpc-1',
            ok: false,
            error: {
              code: 'forbidden',
              message: "Method 'worktree.list' is not available to mobile clients"
            }
          } as RpcResponse)
        : ({ id: 'rpc-1', ok: true, result: {} } as RpcResponse)
    )
    const client = {
      sendRequest,
      getState: () => 'connected' as const
    } as unknown as RpcClient

    await expect(verifyForceReconnectRpcHealth(client)).resolves.toBeUndefined()
    expect(sendRequest).toHaveBeenCalledWith(
      'worktree.ps',
      { limit: 1 },
      expect.objectContaining({ strictDeadline: true })
    )
  })

  it('treats an application-error reply as proof of control-channel liveness', async () => {
    const responsiveness = new RpcApplicationResponsiveness()
    responsiveness.recordTimeout(123)
    const sendRequest = vi.fn(async (method: string) => {
      responsiveness.recordResponse(method)
      return {
        id: 'rpc-1',
        ok: false,
        error: { code: 'internal_error', message: 'worktree scan failed' }
      } as RpcResponse
    })
    const client = {
      sendRequest,
      getState: () => 'connected' as const,
      getRpcUnresponsiveSince: () => responsiveness.getUnresponsiveSince()
    } as unknown as RpcClient

    await expect(verifyForceReconnectRpcHealth(client)).resolves.toBeUndefined()
    expect(sendRequest).toHaveBeenCalledOnce()
  })

  it('rejects an unauthorized reply instead of reporting recovery', async () => {
    const sendRequest = vi.fn(
      async () =>
        ({
          id: 'rpc-1',
          ok: false,
          error: { code: 'unauthorized', message: 'Invalid device token' }
        }) as RpcResponse
    )
    const client = {
      sendRequest,
      getState: () => 'connected' as const
    } as unknown as RpcClient

    await expect(verifyForceReconnectRpcHealth(client)).rejects.toThrow('Invalid device token')
    expect(sendRequest).toHaveBeenCalledOnce()
  })

  it('paces immediately-rejecting recoverable errors instead of spinning', async () => {
    vi.useFakeTimers()
    const sendRequest = vi.fn(() => Promise.reject(new RecoverableRpcError('Client suspended')))
    const client = { sendRequest, getState: () => 'connected' as const } as unknown as RpcClient
    let outcome = 'pending'
    const verification = verifyForceReconnectRpcHealth(client).catch((error: Error) => {
      outcome = error.message
    })

    await vi.advanceTimersByTimeAsync(15_000)
    await verification

    expect(outcome).toBe('Client suspended')
    expect(sendRequest.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(sendRequest.mock.calls.length).toBeLessThanOrEqual(61)
  })

  it('does not classify an untyped message as recoverable', async () => {
    const sendRequest = vi.fn(() => Promise.reject(new Error('Client suspended')))
    const client = { sendRequest, getState: () => 'connected' as const } as unknown as RpcClient

    await expect(verifyForceReconnectRpcHealth(client)).rejects.toThrow('Client suspended')
    expect(sendRequest).toHaveBeenCalledOnce()
  })

  it('fails when authorization retries reach auth-failed', async () => {
    const sendRequest = vi.fn(async () => {
      throw new Error('Unauthorized — pairing may be revoked')
    })
    const client = {
      sendRequest,
      getState: () => 'auth-failed' as const
    } as unknown as RpcClient

    await expect(verifyForceReconnectRpcHealth(client)).rejects.toThrow(
      'Unauthorized — pairing may be revoked'
    )
    expect(sendRequest).toHaveBeenCalledOnce()
  })

  it('waits for a Relay replacement after the active session drops', async () => {
    let state: ConnectionState = 'connected'
    const listeners = new Set<(next: ConnectionState) => void>()
    const sendRequest = vi
      .fn<() => Promise<RpcResponse>>()
      .mockImplementationOnce(async () => {
        state = 'disconnected'
        throw markRpcDeliveryUnknown(new Error('relay RPC interrupted'))
      })
      .mockResolvedValueOnce({ id: 'rpc-2', ok: true, result: {} })
    const client = {
      sendRequest,
      getState: () => state,
      onStateChange: (listener: (next: ConnectionState) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    } as unknown as RpcClient

    const verification = verifyForceReconnectRpcHealth(client)
    await vi.waitFor(() => expect(listeners.size).toBe(1))
    state = 'connected'
    for (const listener of listeners) {
      listener(state)
    }

    await expect(verification).resolves.toBeUndefined()
    expect(sendRequest).toHaveBeenCalledTimes(2)
  })

  it('waits for stable-client migration when Relay disconnects before probe delivery', async () => {
    vi.useFakeTimers()
    let relayDeliveries = 0
    const relaySendRequest = vi.fn(async () => {
      await waitForMobileRelayRpcConnected({
        getState: () => 'disconnected',
        subscribe: () => () => {},
        timeoutMs: 15_000
      })
      relayDeliveries += 1
      return { id: 'rpc-old', ok: true, result: {} } as RpcResponse
    })
    const relay = {
      sendRequest: relaySendRequest,
      getState: () => 'disconnected' as const,
      onStateChange: () => () => {},
      close: vi.fn()
    } as unknown as RpcClient
    const replacementSendRequest = vi.fn(
      async () => ({ id: 'rpc-new', ok: true, result: {} }) as RpcResponse
    )
    const replacement = {
      sendRequest: replacementSendRequest,
      getState: () => 'connected' as const,
      onStateChange: () => () => {},
      close: vi.fn()
    } as unknown as RpcClient
    const logical = createStableLogicalRpcClient(relay, 'relay')
    let outcome = 'pending'
    const verification = verifyForceReconnectRpcHealth(logical).then(
      () => {
        outcome = 'resolved'
      },
      (error: Error) => {
        outcome = error.message
      }
    )

    await vi.advanceTimersByTimeAsync(14_000)
    expect(outcome).toBe('pending')
    await logical.migrateTo(replacement, 'relay')
    await verification

    expect(outcome).toBe('resolved')
    expect(relayDeliveries).toBe(0)
    expect(relaySendRequest).toHaveBeenCalledOnce()
    expect(replacementSendRequest).toHaveBeenCalledOnce()
    expect(replacementSendRequest).toHaveBeenCalledWith(
      'worktree.ps',
      { limit: 1 },
      expect.objectContaining({ timeoutMs: 1_000, strictDeadline: true })
    )
  })
})
