import { describe, expect, it, vi } from 'vitest'
import type { ConnectionState, RpcResponse } from './types'
import type { RpcClient } from './rpc-client'
import {
  createStableLogicalRpcClient,
  LogicalClientCutoverError
} from './stable-logical-rpc-client'

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
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('stable logical RPC client', () => {
  it('makes before break, rejects in-flight work, and replays subscriptions', async () => {
    const oldSession = new FakeSession('connected')
    const nextSession = new FakeSession('connecting')
    const pending = deferred<RpcResponse>()
    oldSession.sendRequest.mockReturnValue(pending.promise)
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
    expect(client.getActivePath()).toBe('relay')
    expect(client.getGeneration()).toBe(2)
    oldSession.emitStream('stale')
    nextSession.emitStream('current')
    expect(stream).toHaveBeenCalledOnce()
    expect(stream).toHaveBeenCalledWith('current')
    pending.resolve(success('late'))
  })

  it('keeps replies that commit before cutover and carries viewport state into replay', async () => {
    const oldSession = new FakeSession('connected')
    const nextSession = new FakeSession('connected')
    oldSession.sendRequest.mockResolvedValue(success('old'))
    const client = createStableLogicalRpcClient(oldSession, 'lan')
    client.subscribe(
      'terminal.subscribe',
      { terminal: 'term-1', viewport: { cols: 80, rows: 24 } },
      vi.fn()
    )
    client.updateTerminalSubscriptionViewport('term-1', { cols: 120, rows: 40 })

    await expect(client.sendRequest('status.get')).resolves.toEqual(success('old'))
    await client.migrateTo(nextSession, 'relay')
    expect(nextSession.subscribe).toHaveBeenCalledWith(
      'terminal.subscribe',
      { terminal: 'term-1', viewport: { cols: 120, rows: 40 } },
      expect.any(Function),
      undefined
    )
  })

  it('suspends one physical session and replays subscriptions on foreground replacement', async () => {
    const oldSession = new FakeSession('connected')
    const nextSession = new FakeSession('connected')
    nextSession.sendRequest.mockResolvedValue(success('next'))
    const client = createStableLogicalRpcClient(oldSession, 'relay')
    client.subscribe('session.tabs.subscribe', { worktree: 'id:wt-1' }, vi.fn())

    client.suspendActiveSession()

    expect(oldSession.close).toHaveBeenCalledOnce()
    expect(client.getState()).toBe('disconnected')
    await expect(client.sendRequest('status.get')).rejects.toThrow('Client suspended')

    await client.migrateTo(nextSession, 'relay')

    expect(nextSession.subscribe).toHaveBeenCalledWith(
      'session.tabs.subscribe',
      { worktree: 'id:wt-1' },
      expect.any(Function),
      undefined
    )
    await expect(client.sendRequest('status.get')).resolves.toEqual(success('next'))
  })

  it('closes a replacement that fails authentication and preserves the active session', async () => {
    const oldSession = new FakeSession('connected')
    const replacement = new FakeSession('connecting')
    const client = createStableLogicalRpcClient(oldSession, 'lan')
    const migrating = client.migrateTo(replacement, 'relay')
    replacement.setState('auth-failed')

    await expect(migrating).rejects.toThrow(/auth-failed/)
    expect(replacement.close).toHaveBeenCalledOnce()
    expect(oldSession.close).not.toHaveBeenCalled()
    expect(client.getActivePath()).toBe('lan')
    expect(client.getGeneration()).toBe(1)
  })
})
