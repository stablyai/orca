import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startHostBotRefresh } from './host-bot-refresh'
import type { BotChangeInterest } from '../../../src/shared/bots/bot-change-scope'

function harness(listed = true, interest?: () => BotChangeInterest) {
  let emit: (payload: unknown) => void = () => {}
  const unsubscribe = vi.fn()
  const client = {
    subscribe: vi.fn((_method: string, _params: unknown, onData: (payload: unknown) => void) => {
      emit = onData
      return unsubscribe
    })
  }
  let onChange: (state: string) => void = () => {}
  const appState = {
    currentState: 'active',
    addEventListener: (_type: 'change', listener: (state: string) => void) => {
      onChange = listener
      return { remove: vi.fn() }
    }
  }
  const refresh = vi.fn()
  const stop = startHostBotRefresh({
    client,
    appState,
    refresh,
    listed: () => listed,
    ...(interest ? { interest } : {})
  })
  return {
    emit: (payload: unknown) => emit(payload),
    onChange,
    appState,
    refresh,
    stop,
    unsubscribe
  }
}

describe('startHostBotRefresh', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('reads at once, then on botsChanged, a replayed ready and the foreground, with no poll', () => {
    const run = harness()
    expect(run.refresh).toHaveBeenCalledTimes(1)
    run.emit({ type: 'ready', subscriptionId: 's' })
    vi.advanceTimersByTime(10_000)
    expect(run.refresh).toHaveBeenCalledTimes(1)
    run.emit({ type: 'botsChanged' })
    run.emit({ type: 'worktreesChanged', repoId: 'r' })
    expect(run.refresh).toHaveBeenCalledTimes(2)
    // A second ready is the stream replaying after a reconnect.
    run.emit({ type: 'ready', subscriptionId: 's' })
    expect(run.refresh).toHaveBeenCalledTimes(3)
    run.onChange('active')
    expect(run.refresh).toHaveBeenCalledTimes(4)
    run.stop()
    expect(run.unsubscribe).toHaveBeenCalledOnce()
  })

  it("skips a notice about another bot's chats, and reads an older host's notice that names none", () => {
    const run = harness(true, () => ({ botId: 'bot-a', kinds: ['chats', 'status'] }))
    run.emit({ type: 'ready', subscriptionId: 's' })
    run.emit({ type: 'botsChanged', botIds: ['bot-b'], kinds: ['chats'] })
    expect(run.refresh).toHaveBeenCalledTimes(1)
    run.emit({ type: 'botsChanged', botIds: ['bot-a'], kinds: ['status'] })
    expect(run.refresh).toHaveBeenCalledTimes(2)
    run.emit({ type: 'botsChanged' })
    expect(run.refresh).toHaveBeenCalledTimes(3)
    run.stop()
  })

  it('waits in the background for the foreground re-read', () => {
    const run = harness()
    run.emit({ type: 'ready', subscriptionId: 's' })
    run.appState.currentState = 'background'
    run.emit({ type: 'botsChanged' })
    expect(run.refresh).toHaveBeenCalledTimes(1)
    run.stop()
  })

  it('polls after a failed read, and a stream that is not up yet', () => {
    const failed = harness(false)
    failed.emit({ type: 'ready', subscriptionId: 's' })
    vi.advanceTimersByTime(3000)
    expect(failed.refresh).toHaveBeenCalledTimes(2)
    failed.stop()
    const fresh = harness()
    vi.advanceTimersByTime(3000)
    expect(fresh.refresh).toHaveBeenCalledTimes(2)
    fresh.emit({ type: 'ready', subscriptionId: 's' })
    vi.advanceTimersByTime(3000)
    expect(fresh.refresh).toHaveBeenCalledTimes(2)
    fresh.stop()
  })
})
