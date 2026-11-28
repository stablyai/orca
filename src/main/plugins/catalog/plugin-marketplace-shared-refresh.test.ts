import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginMarketplaceSourceState } from './plugin-marketplace-projection'
import { sharedSourceRefresh } from './plugin-marketplace-shared-refresh'

function stateFor(id: string, call: number): PluginMarketplaceSourceState {
  return {
    id,
    source: { kind: 'git', url: `https://example.com/${id}.git`, ref: 'main' },
    addedAt: call,
    marketplace: null,
    stale: false,
    official: false
  }
}

describe('sharedSourceRefresh', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reuses a refresh within the window and evicts expired entries automatically', async () => {
    vi.useFakeTimers()
    let calls = 0
    const shared = sharedSourceRefresh(async (id) => stateFor(id, ++calls))

    const first = await shared('src-a', 0)
    const reused = await shared('src-a', 5_000)
    expect(reused).toBe(first)
    expect(calls).toBe(1)

    // Timer eviction clears the entry after the window even with no further calls.
    vi.advanceTimersByTime(10_000)
    const afterTimer = await shared('src-a', 5_000)
    expect(afterTimer).not.toBe(first)
    expect(calls).toBe(2)

    // Explicit timestamp progression also evicts expired entries.
    const afterWindow = await shared('src-a', 15_000)
    expect(afterWindow).not.toBe(afterTimer)
    expect(calls).toBe(3)
  })

  it('evicts a removed source immediately via evict()', async () => {
    let calls = 0
    const shared = sharedSourceRefresh(async (id) => stateFor(id, ++calls))

    const first = await shared('src-a', 0)
    shared.evict('src-a')

    const second = await shared('src-a', 1_000)
    expect(second).not.toBe(first)
    expect(calls).toBe(2)
  })
})
