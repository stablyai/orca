import { describe, expect, it, vi } from 'vitest'
import './relay-dial-stage'
import type { ConnectionState, RpcResponse } from './types'
import type { RpcClient } from './rpc-client'
import './rpc-delivery-ambiguity'
import {
  createStableLogicalRpcClient,
  LogicalClientCutoverError
} from './stable-logical-rpc-client'
import './logical-client-suspended-error'

class FakeSession implements RpcClient {
  readonly sendRequest =
    vi.fn<
      (method: string, params?: unknown, options?: { timeoutMs?: number }) => Promise<RpcResponse>
    >()
  readonly subscribe = vi.fn<RpcClient['subscribe']>()
  readonly updateTerminalSubscriptionViewport =
    vi.fn<RpcClient['updateTerminalSubscriptionViewport']>()
  readonly notifyForeground = vi.fn()
  readonly close = vi.fn()
  private state: ConnectionState
  private readonly stateListeners = new Set<(state: ConnectionState) => void>()
  private readonly streamListeners = new Set<(result: unknown) => void>()

  constructor(state: ConnectionState) {
    this.state = state
    this.subscribe.mockImplementation((_method, _params, listener) => {
      this.streamListeners.add(listener)
      return () => this.streamListeners.delete(listener)
    })
  }

  getState = (): ConnectionState => this.state
  getReconnectAttempt = (): number => 0
  getLastConnectedAt = (): number | null => null
  onStateChange = (listener: (state: ConnectionState) => void): (() => void) => {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  setState(state: ConnectionState): void {
    this.state = state
    for (const listener of this.stateListeners) {
      listener(state)
    }
  }

  emitStream(value: unknown): void {
    for (const listener of this.streamListeners) {
      listener(value)
    }
  }
}

function success(value: unknown): RpcResponse {
  return { id: 'rpc-1', ok: true, result: value, _meta: { runtimeId: 'runtime-1' } }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('stable logical RPC client', () => {
  it('makes before break, rejects in-flight work, and replays subscriptions', async () => {
    const oldSession = new FakeSession('connected')
    const nextSession = new FakeSession('connecting')
    const pending = deferred<RpcResponse>()
    oldSession.sendRequest.mockReturnValue(pending.promise)
    oldSession.close.mockImplementation(() => pending.reject(new Error('Client closed')))
    nextSession.sendRequest.mockResolvedValue(success('next'))
    const client = createStableLogicalRpcClient(oldSession, 'lan')
    const stream = vi.fn()
    client.subscribe('terminal.subscribe', { terminal: 'term-1' }, stream)
    const request = client.sendRequest('worktree.create', { name: 'new' })

    const migrating = client.migrateTo(nextSession, 'relay')
    expect(oldSession.close).not.toHaveBeenCalled()
    expect(nextSession.subscribe).not.toHaveBeenCalled()
    nextSession.setState('connected')
    await migrating

    await expect(request).rejects.toBeInstanceOf(LogicalClientCutoverError)
    expect(nextSession.subscribe).toHaveBeenCalledWith(
      'terminal.subscribe',
      { terminal: 'term-1' },
      expect.any(Function),
      undefined
    )
    expect(oldSession.close).toHaveBeenCalledOnce()
    expect(nextSession.subscribe.mock.invocationCallOrder[0]).toBeLessThan(
      oldSession.close.mock.invocationCallOrder[0]!
    )
    expect(client.getActivePath()).toBe('relay')
    expect(client.getGeneration()).toBe(2)
    oldSession.emitStream('stale')
    nextSession.emitStream('current')
    expect(stream).toHaveBeenCalledOnce()
    expect(stream).toHaveBeenCalledWith('current')
    pending.resolve(success('late'))
  })

  it('preserves a committed response when logical close wins the callback race', async () => {
    const session = new FakeSession('connected')
    const inFlight = deferred<RpcResponse>()
    session.sendRequest.mockReturnValue(inFlight.promise)
    const client = createStableLogicalRpcClient(session, 'lan')
    const request = client.sendRequest('terminal.send', { terminal: 'term', text: 'hi' })

    inFlight.resolve(success('accepted'))
    client.close()

    await expect(request).resolves.toEqual(success('accepted'))
  })
})

describe('stable logical RPC client subscription fencing', () => {
  // An inert physical disposer leaves only the logical generation guard to reject late events.
  function leakySession() {
    const session = new FakeSession('connected')
    const listeners = new Set<(result: unknown) => void>()
    session.subscribe.mockImplementation((_method, _params, listener) => {
      listeners.add(listener)
      return () => {}
    })
    return {
      session,
      emit(value: unknown): void {
        for (const listener of listeners) {
          listener(value)
        }
      }
    }
  }

  it('drops a stream event that lands after the caller unsubscribed', () => {
    const physical = leakySession()
    const client = createStableLogicalRpcClient(physical.session, 'lan')
    const listener = vi.fn()
    const unsubscribe = client.subscribe(
      'notifications.subscribe',
      { includeDesktopSuppressed: true },
      listener
    )

    unsubscribe()
    physical.emit({ type: 'ready', subscriptionId: 'sub-1' })

    expect(listener).not.toHaveBeenCalled()
  })
})
