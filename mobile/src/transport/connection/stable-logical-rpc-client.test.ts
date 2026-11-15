import { describe, expect, it, vi } from 'vitest'

import type { ConnectionState } from './connection-state'
import type { RpcResponse } from '../rpc/rpc-wire-types'
import type { RpcClient } from '../rpc/rpc-client-contract'

import { createStableLogicalRpcClient } from './stable-logical-rpc-client'

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
