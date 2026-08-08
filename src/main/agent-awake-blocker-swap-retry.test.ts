import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AgentAwakeBlockerSwapRetry,
  AGENT_AWAKE_BLOCKER_SWAP_RETRY_MS
} from './agent-awake-blocker-swap-retry'

describe('AgentAwakeBlockerSwapRetry', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('makes at most one retry for the same blocker target', () => {
    let retry: AgentAwakeBlockerSwapRetry
    const callback = vi.fn(() => retry.schedule('prevent-app-suspension'))
    retry = new AgentAwakeBlockerSwapRetry(callback)

    retry.schedule('prevent-app-suspension')
    vi.advanceTimersByTime(AGENT_AWAKE_BLOCKER_SWAP_RETRY_MS * 10)

    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('cancels a pending retry when cleared', () => {
    const callback = vi.fn()
    const retry = new AgentAwakeBlockerSwapRetry(callback)

    retry.schedule('prevent-app-suspension')
    retry.clear()
    vi.advanceTimersByTime(AGENT_AWAKE_BLOCKER_SWAP_RETRY_MS)

    expect(callback).not.toHaveBeenCalled()
  })
})
