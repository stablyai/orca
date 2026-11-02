import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayDialStageTracker } from './relay-dial-stage'
import {
  ReplacementAuthenticationTimeoutError,
  waitForAuthenticated
} from './replacement-session-authentication'
import type { RpcClient } from './rpc-client'
import type { ConnectionState } from './types'

class FakeSession implements RpcClient {
  readonly sendRequest = vi.fn()
  readonly subscribe = vi.fn(() => () => {})
  readonly updateTerminalSubscriptionViewport = vi.fn()
  readonly notifyForeground = vi.fn()
  readonly close = vi.fn()
  private readonly listeners = new Set<(state: ConnectionState) => void>()
  constructor(private state: ConnectionState = 'connecting') {}
  getState = () => this.state
  getReconnectAttempt = () => 0
  getLastConnectedAt = () => null
  onStateChange = (listener: (state: ConnectionState) => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  listenerCount(): number {
    return this.listeners.size
  }
  setState(state: ConnectionState): void {
    this.state = state
    for (const listener of this.listeners) {
      listener(state)
    }
  }
}

class FakeRelaySession extends FakeSession {
  readonly dialStage = new RelayDialStageTracker()
  getDialStage = () => this.dialStage.getDialStage()
  onDialStageChange = this.dialStage.onDialStageChange.bind(this.dialStage)
}

// Why: fake timers are active, so "still pending" is decided on the microtask queue.
async function settle<T>(
  promise: Promise<T>
): Promise<{ status: 'pending' | 'settled'; error?: Error }> {
  let outcome: { status: 'pending' | 'settled'; error?: Error } = { status: 'pending' }
  void promise.then(
    () => (outcome = { status: 'settled' }),
    (error: Error) => (outcome = { status: 'settled', error })
  )
  await Promise.resolve()
  await Promise.resolve()
  return outcome
}

describe('waitForAuthenticated', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('keeps the flat bound for a session that reports no dial stages', async () => {
    const session = new FakeSession()
    const waiting = waitForAuthenticated(session, 12_000)
    waiting.catch(() => {})
    await vi.advanceTimersByTimeAsync(11_999)
    expect((await settle(waiting)).status).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    const outcome = await settle(waiting)
    expect(outcome.error).toBeInstanceOf(ReplacementAuthenticationTimeoutError)
    expect(outcome.error?.message).toBe('replacement session authentication timed out')
    expect(session.listenerCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  // Allow lock-contended cell assignment past the opening deadline through per-stage budgets.
  it('re-arms the bound per stage once the cell holds the dial', async () => {
    const session = new FakeRelaySession()
    const waiting = waitForAuthenticated(session, 12_000)
    waiting.catch(() => {})
    await vi.advanceTimersByTimeAsync(11_000)
    session.dialStage.advance('awaiting-hello')
    await vi.advanceTimersByTimeAsync(5_000)
    expect((await settle(waiting)).status).toBe('pending')
    session.dialStage.advance('handshaking')
    session.setState('handshaking')
    await vi.advanceTimersByTimeAsync(11_000)
    expect((await settle(waiting)).status).toBe('pending')
    session.dialStage.advance('confirming')
    await vi.advanceTimersByTimeAsync(20_000)
    session.setState('connected')
    await expect(waiting).resolves.toBeUndefined()
    expect(session.listenerCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds a cell that took the dial and never answers, naming the stage', async () => {
    const session = new FakeRelaySession()
    const waiting = waitForAuthenticated(session, 12_000)
    waiting.catch(() => {})
    await vi.advanceTimersByTimeAsync(2_000)
    session.dialStage.advance('awaiting-hello')
    await vi.advanceTimersByTimeAsync(29_999)
    expect((await settle(waiting)).status).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    const outcome = await settle(waiting)
    expect(outcome.error).toBeInstanceOf(ReplacementAuthenticationTimeoutError)
    if (!(outcome.error instanceof ReplacementAuthenticationTimeoutError)) {
      throw new Error('Expected a stage timeout')
    }
    expect(outcome.error.stage).toBe('awaiting-hello')
    expect(outcome.error?.message).toBe(
      'replacement session authentication timed out (awaiting-hello, 30s)'
    )
    expect(session.listenerCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the caller bound while the socket never opens', async () => {
    const session = new FakeRelaySession()
    const waiting = waitForAuthenticated(session, 12_000)
    waiting.catch(() => {})
    await vi.advanceTimersByTimeAsync(11_999)
    expect((await settle(waiting)).status).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    const outcome = await settle(waiting)
    expect(outcome.error).toBeInstanceOf(ReplacementAuthenticationTimeoutError)
    if (!(outcome.error instanceof ReplacementAuthenticationTimeoutError)) {
      throw new Error('Expected an opening timeout')
    }
    expect(outcome.error.stage).toBe('opening')
    expect(outcome.error?.message).toBe(
      'replacement session authentication timed out (opening, 12s)'
    )
    expect(session.listenerCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores stage advances after the wait has settled', async () => {
    const session = new FakeRelaySession()
    const waiting = waitForAuthenticated(session, 12_000)
    session.setState('disconnected')
    await expect(waiting).rejects.toThrow('replacement session disconnected')
    expect(session.listenerCount()).toBe(0)
    session.dialStage.advance('awaiting-hello')
    expect(vi.getTimerCount()).toBe(0)
  })
})
