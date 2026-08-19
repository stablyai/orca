import { describe, expect, it, vi } from 'vitest'
import type { ConnectionState, RpcResponse } from './types'
import type { RpcClient } from './rpc-client'
import { isRpcDeliveryUnknown, markRpcDeliveryUnknown } from './rpc-delivery-ambiguity'
import {
  createStableLogicalRpcClient,
  LogicalClientCutoverError,
  type MobileConnectionPath
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
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('stable logical RPC client', () => {
  it('advertises source-default support on worktree catalog requests', async () => {
    const session = new FakeSession('connected')
    session.sendRequest.mockResolvedValue(success([]))
    const client = createStableLogicalRpcClient(session, 'lan')

    await client.sendRequest('worktree.ps', { limit: 10_000 })
    await client.sendRequest('status.get')

    expect(session.sendRequest).toHaveBeenNthCalledWith(
      1,
      'worktree.ps',
      { limit: 10_000, supportsWorktreeVisibilitySourceDefaults: true },
      undefined
    )
    expect(session.sendRequest).toHaveBeenNthCalledWith(2, 'status.get', undefined, undefined)
  })

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

  it('preserves delivery ambiguity without replaying a mutation after relay replacement', async () => {
    const session = new FakeSession('connected')
    const replacement = new FakeSession('connected')
    const inFlight = deferred<RpcResponse>()
    session.sendRequest.mockReturnValue(inFlight.promise)
    // Mirror the real physical contract: close() rejects post-write pendings
    // with a delivery-unknown-marked error.
    const closeError = markRpcDeliveryUnknown(new Error('Client closed'))
    session.close.mockImplementation(() => inFlight.reject(closeError))
    const client = createStableLogicalRpcClient(session, 'relay')
    const request = client.sendRequest('terminal.send', { terminal: 'term', text: 'hi' })

    client.suspendActiveSession()

    await expect(request).rejects.toBe(closeError)
    await expect(request.catch((error: unknown) => isRpcDeliveryUnknown(error))).resolves.toBe(true)
    await client.migrateTo(replacement, 'relay')
    expect(replacement.sendRequest).not.toHaveBeenCalled()
    replacement.sendRequest.mockResolvedValue(success('next'))
    await expect(client.sendRequest('status.get')).resolves.toEqual(success('next'))
  })

  it('lets the physical close settle in-flight requests on close, keeping pre-write failures definite', async () => {
    const session = new FakeSession('connected')
    const inFlight = deferred<RpcResponse>()
    session.sendRequest.mockReturnValue(inFlight.promise)
    // A request still waiting for connect never wrote its frame — the physical
    // layer rejects it unmarked and that must survive the logical close.
    const preWriteError = new Error('Connection closed')
    session.close.mockImplementation(() => inFlight.reject(preWriteError))
    const client = createStableLogicalRpcClient(session, 'lan')
    const request = client.sendRequest('terminal.send', { terminal: 'term', text: 'hi' })

    client.close()

    await expect(request).rejects.toBe(preWriteError)
    await expect(request.catch((error: unknown) => isRpcDeliveryUnknown(error))).resolves.toBe(
      false
    )
  })

  it('publishes the replacement dial phases while the client is suspended', async () => {
    const oldSession = new FakeSession('connected')
    const replacement = new FakeSession('connecting')
    const client = createStableLogicalRpcClient(oldSession, 'relay')
    const states: ConnectionState[] = []
    client.onStateChange((next) => states.push(next))

    client.suspendActiveSession()
    expect(client.getPendingPath()).toBeNull()

    const migrating = client.migrateTo(replacement, 'relay')
    replacement.setState('connecting')
    expect(client.getState()).toBe('connecting')
    expect(client.getPendingPath()).toBe('relay')
    replacement.setState('handshaking')
    expect(client.getState()).toBe('handshaking')
    replacement.setState('connected')
    await migrating

    expect(states).toEqual(['disconnected', 'connecting', 'handshaking', 'connected'])
    expect(client.getPendingPath()).toBeNull()
    expect(client.getActivePath()).toBe('relay')
  })

  // A replacement relay session that retries internally publishes 'reconnecting' as one of
  // its own dial phases. Forwarding it is the point: amber "Reconnecting…" beats the grey
  // the suspended client would otherwise hold for the whole dial.
  it('forwards a reconnecting phase published by the dialing session itself', async () => {
    const oldSession = new FakeSession('connected')
    const replacement = new FakeSession('connecting')
    const client = createStableLogicalRpcClient(oldSession, 'relay')
    client.suspendActiveSession()
    const states: ConnectionState[] = []
    client.onStateChange((next) => states.push(next))

    const migrating = client.migrateTo(replacement, 'relay')
    replacement.setState('connecting')
    replacement.setState('reconnecting')
    expect(client.getState()).toBe('reconnecting')
    replacement.setState('handshaking')
    replacement.setState('connected')
    await migrating

    expect(states).toEqual(['connecting', 'reconnecting', 'handshaking', 'connected'])
  })

  // The dominant relay case: the direct dial failed, so the client sits in 'reconnecting'
  // (never 'disconnected') while its retry loop lives. The dot is already amber there, so
  // nothing is forwarded — but the pending path must still name what is being dialed.
  it('names a relay dial started from reconnecting without disturbing the state', async () => {
    const direct = new FakeSession('connected')
    const replacement = new FakeSession('connecting')
    const client = createStableLogicalRpcClient(direct, 'lan')
    direct.setState('reconnecting')
    const states: ConnectionState[] = []
    const paths: (MobileConnectionPath | null)[] = []
    client.onStateChange((next) => states.push(next))
    client.onConnectionPathChange(() => paths.push(client.getPendingPath()))

    const migrating = client.migrateTo(replacement, 'relay')
    expect(client.getPendingPath()).toBe('relay')
    expect(paths).toEqual(['relay'])
    replacement.setState('connecting')
    replacement.setState('handshaking')

    // The still-bound direct session keeps cycling; the forwarder must not fight it.
    expect(client.getState()).toBe('reconnecting')
    expect(states).toEqual([])

    replacement.setState('connected')
    await migrating

    expect(states).toEqual(['connected'])
    expect(client.getPendingPath()).toBeNull()
    expect(client.getActivePath()).toBe('relay')
  })

  it('publishes recovery-path changes and keeps Relay pending between failed dials', async () => {
    const direct = new FakeSession('reconnecting')
    const replacement = new FakeSession('connecting')
    const client = createStableLogicalRpcClient(direct, 'tailscale')
    const paths: (MobileConnectionPath | null)[] = []
    client.onConnectionPathChange(() => paths.push(client.getPendingPath()))

    client.setRecoveryPath('relay')
    const migrating = client.migrateTo(replacement, 'relay')
    replacement.setState('disconnected')
    await expect(migrating).rejects.toThrow(/disconnected/)

    expect(client.getPendingPath()).toBe('relay')
    expect(paths).toEqual(['relay'])

    client.setRecoveryPath(null)
    expect(client.getPendingPath()).toBeNull()
    expect(paths).toEqual(['relay', null])
  })

  it('publishes supervisor Relay attempts without replacing the physical retry count', () => {
    const direct = new FakeSession('reconnecting')
    direct.getReconnectAttempt = () => 5
    const client = createStableLogicalRpcClient(direct, 'tailscale')
    const attempts: number[] = []
    client.onConnectionPathChange(() => attempts.push(client.getReconnectAttempt()))

    client.setRecoveryPath('relay', 3)
    expect(client.getReconnectAttempt()).toBe(5)

    client.setRecoveryAttempt(7)
    expect(client.getReconnectAttempt()).toBe(7)
    expect(attempts).toEqual([5, 7])

    client.setRecoveryPath(null)
    expect(client.getReconnectAttempt()).toBe(5)
    expect(attempts).toEqual([5, 7, 5])
  })

  it('notifies connection-path subscribers when the pairing-rejected latch flips', () => {
    const direct = new FakeSession('reconnecting')
    const client = createStableLogicalRpcClient(direct, 'tailscale')
    const rejected: boolean[] = []
    client.onConnectionPathChange(() => rejected.push(client.isPairingRejected()))

    client.setPairingRejected(true)
    client.setPairingRejected(true)
    client.setPairingRejected(false)

    expect(rejected).toEqual([true, false])
  })

  it('does not revive a stale recovery path after a connection later drops', () => {
    const direct = new FakeSession('reconnecting')
    const client = createStableLogicalRpcClient(direct, 'tailscale')

    client.setRecoveryPath('relay')
    direct.setState('connected')
    direct.setState('reconnecting')

    expect(client.getPendingPath()).toBeNull()
  })

  it('drops the pending path when the previous session recovers mid-dial', async () => {
    const direct = new FakeSession('connected')
    const replacement = new FakeSession('connecting')
    const client = createStableLogicalRpcClient(direct, 'lan')
    direct.setState('reconnecting')

    const migrating = client.migrateTo(replacement, 'relay')
    expect(client.getPendingPath()).toBe('relay')

    direct.setState('connected')
    expect(client.getPendingPath()).toBeNull()

    replacement.setState('connected')
    await migrating
  })

  it('never downgrades a live session while a make-before-break replacement dials', async () => {
    const oldSession = new FakeSession('connected')
    const replacement = new FakeSession('connecting')
    const client = createStableLogicalRpcClient(oldSession, 'relay')
    const states: ConnectionState[] = []
    client.onStateChange((next) => states.push(next))

    const migrating = client.migrateTo(replacement, 'relay')
    replacement.setState('connecting')
    replacement.setState('handshaking')

    expect(client.getState()).toBe('connected')
    expect(client.getPendingPath()).toBeNull()

    replacement.setState('connected')
    await migrating

    expect(states).toEqual(['connected'])
  })

  it('restores disconnected when a dial it was narrating fails', async () => {
    const session = new FakeSession('connected')
    const replacement = new FakeSession('connecting')
    const client = createStableLogicalRpcClient(session, 'relay')
    client.suspendActiveSession()
    const states: ConnectionState[] = []
    client.onStateChange((next) => states.push(next))

    const migrating = client.migrateTo(replacement, 'relay')
    replacement.setState('handshaking')
    replacement.setState('disconnected')

    await expect(migrating).rejects.toThrow(/disconnected/)
    expect(states).toEqual(['handshaking', 'disconnected'])
    expect(client.getState()).toBe('disconnected')
    expect(client.getPendingPath()).toBeNull()
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
