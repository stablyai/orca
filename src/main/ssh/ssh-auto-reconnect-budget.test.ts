import { describe, expect, it } from 'vitest'
import { AUTO_RECONNECT_BUDGET_MS, SshAutoReconnectBudget } from './ssh-auto-reconnect-budget'
import { CONNECT_TIMEOUT_MS } from './ssh-connection-utils'
import { STABLE_CONNECTION_MS } from './ssh-reconnect-ladder'

describe('SshAutoReconnectBudget', () => {
  it('stays unexhausted until the wall-clock window elapses', () => {
    const budget = new SshAutoReconnectBudget()

    // No window opened yet — a target that has never failed must never read as exhausted.
    expect(budget.isExhausted('a', 0)).toBe(false)

    expect(budget.deadlineFor('a', 1_000)).toBe(1_000 + AUTO_RECONNECT_BUDGET_MS)
    expect(budget.isExhausted('a', 1_000)).toBe(false)
    expect(budget.isExhausted('a', 1_000 + AUTO_RECONNECT_BUDGET_MS - 1)).toBe(false)
    expect(budget.isExhausted('a', 1_000 + AUTO_RECONNECT_BUDGET_MS)).toBe(true)
  })

  it('keeps the original deadline across repeated reads so retries cannot extend the window', () => {
    const budget = new SshAutoReconnectBudget()
    const deadline = budget.deadlineFor('a', 1_000)

    // Every later attempt during the outage must observe the same deadline — this is what makes
    // the bound wall-clock rather than per-attempt.
    expect(budget.deadlineFor('a', 20_000)).toBe(deadline)
    expect(budget.deadlineFor('a', 59_000)).toBe(deadline)
  })

  it('scopes the window per target', () => {
    const budget = new SshAutoReconnectBudget()
    budget.deadlineFor('a', 0)

    expect(budget.isExhausted('a', AUTO_RECONNECT_BUDGET_MS)).toBe(true)
    expect(budget.isExhausted('b', AUTO_RECONNECT_BUDGET_MS)).toBe(false)
  })

  it('re-earns a full window after reset', () => {
    const budget = new SshAutoReconnectBudget()
    budget.deadlineFor('a', 0)
    expect(budget.isExhausted('a', AUTO_RECONNECT_BUDGET_MS)).toBe(true)

    // A user-initiated connect (or a reached host) resets — the next failure opens a fresh window.
    budget.reset('a')
    expect(budget.isExhausted('a', AUTO_RECONNECT_BUDGET_MS)).toBe(false)
    expect(budget.deadlineFor('a', AUTO_RECONNECT_BUDGET_MS)).toBe(2 * AUTO_RECONNECT_BUDGET_MS)
  })

  it('does not expire the pause on its own', () => {
    const budget = new SshAutoReconnectBudget()
    budget.deadlineFor('a', 0)

    // Hard stop: once paused it stays paused until something resets it, however long the app runs.
    expect(budget.isExhausted('a', 24 * 60 * 60 * 1000)).toBe(true)
  })

  it('honors a custom budget', () => {
    const budget = new SshAutoReconnectBudget(5_000)
    expect(budget.deadlineFor('a', 0)).toBe(5_000)
    expect(budget.isExhausted('a', 4_999)).toBe(false)
    expect(budget.isExhausted('a', 5_000)).toBe(true)
  })

  it('keeps the window open when a handshake does not survive to stability', () => {
    const budget = new SshAutoReconnectBudget()
    budget.deadlineFor('a', 0)

    // A flap storm reconnects constantly; each short-lived handshake must earn nothing, or the
    // window rolls forward forever and the give-up is never reached.
    budget.markConnected('a', 10_000)
    budget.noteDropped('a', 10_000 + STABLE_CONNECTION_MS - 1)
    expect(budget.isExhausted('a', AUTO_RECONNECT_BUDGET_MS)).toBe(true)
  })

  it('re-earns a full window after a connection that held to stability', () => {
    const budget = new SshAutoReconnectBudget()
    budget.deadlineFor('a', 0)

    budget.markConnected('a', 10_000)
    budget.noteDropped('a', 10_000 + STABLE_CONNECTION_MS)
    expect(budget.isExhausted('a', AUTO_RECONNECT_BUDGET_MS)).toBe(false)
    expect(budget.deadlineFor('a', 100_000)).toBe(100_000 + AUTO_RECONNECT_BUDGET_MS)
  })

  it('consumes the handshake mark once so one stable stretch cannot pay for later drops', () => {
    const budget = new SshAutoReconnectBudget()
    budget.markConnected('a', 0)
    budget.noteDropped('a', STABLE_CONNECTION_MS)

    budget.deadlineFor('a', STABLE_CONNECTION_MS)
    // Second drop without a new handshake: nothing left to spend, so the window stands.
    budget.noteDropped('a', STABLE_CONNECTION_MS + AUTO_RECONNECT_BUDGET_MS)
    expect(budget.isExhausted('a', STABLE_CONNECTION_MS + AUTO_RECONNECT_BUDGET_MS)).toBe(true)
  })

  it('drops a pending handshake mark on reset', () => {
    const budget = new SshAutoReconnectBudget()
    budget.markConnected('a', 0)
    budget.reset('a')

    budget.deadlineFor('a', 1_000)
    // The pre-reset handshake belongs to the old window and must not resolve the new one.
    budget.noteDropped('a', 1_000 + STABLE_CONNECTION_MS)
    expect(budget.isExhausted('a', 1_000 + AUTO_RECONNECT_BUDGET_MS)).toBe(true)
  })

  it('clears every target on clear', () => {
    const budget = new SshAutoReconnectBudget()
    budget.deadlineFor('a', 0)
    budget.deadlineFor('b', 0)

    budget.clear()
    expect(budget.isExhausted('a', AUTO_RECONNECT_BUDGET_MS)).toBe(false)
    expect(budget.isExhausted('b', AUTO_RECONNECT_BUDGET_MS)).toBe(false)
  })

  it('leaves room for at least two full connect timeouts', () => {
    // Deliberate product floor: 60s buys ~2 dials against a dead host, not a long retry campaign.
    expect(AUTO_RECONNECT_BUDGET_MS).toBeGreaterThanOrEqual(2 * CONNECT_TIMEOUT_MS)
  })
})
