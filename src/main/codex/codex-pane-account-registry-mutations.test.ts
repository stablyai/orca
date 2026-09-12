import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodexPaneAccountRegistryMutations } from './codex-pane-account-registry-mutations'
import type { CodexPaneAccountRegistryFile } from './codex-pane-account-registry-types'

const EXISTING = {
  selectionKey: 'host',
  accountId: 'account-1',
  homeRoute: 'account-home'
} as const

const SPAWNED = {
  selectionKey: 'host',
  accountId: 'account-2',
  homeRoute: 'account-home'
} as const

function parseRegistry(serialized: string): CodexPaneAccountRegistryFile {
  return JSON.parse(serialized) as CodexPaneAccountRegistryFile
}

describe('CodexPaneAccountRegistryMutations', () => {
  beforeEach(() => vi.useFakeTimers())

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('retries a one-shot spawn record and merges it with the recovered file', async () => {
    let readable = false
    let persisted = JSON.stringify({ version: 2, panes: { existing: EXISTING } })
    const write = vi.fn((registry: CodexPaneAccountRegistryFile) => {
      persisted = JSON.stringify(registry)
      return true
    })
    const mutations = new CodexPaneAccountRegistryMutations({
      read: () => (readable ? parseRegistry(persisted) : null),
      write
    })

    mutations.record('spawned', SPAWNED)
    expect(write).not.toHaveBeenCalled()

    readable = true
    await vi.advanceTimersByTimeAsync(100)

    expect(parseRegistry(persisted).panes).toEqual({ existing: EXISTING, spawned: SPAWNED })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds automatic retries but keeps the pending mutation for a later read', async () => {
    let readable = false
    let persisted = JSON.stringify({ version: 2, panes: { existing: EXISTING } })
    const read = vi.fn(() => (readable ? parseRegistry(persisted) : null))
    const write = vi.fn((registry: CodexPaneAccountRegistryFile) => {
      persisted = JSON.stringify(registry)
      return true
    })
    const mutations = new CodexPaneAccountRegistryMutations({ read, write })

    mutations.record('spawned', SPAWNED)
    await vi.advanceTimersByTimeAsync(120_000)

    expect(read).toHaveBeenCalledTimes(5)
    expect(vi.getTimerCount()).toBe(0)

    readable = true
    mutations.flush()
    expect(parseRegistry(persisted).panes.spawned).toEqual(SPAWNED)
  })

  it('retries durability after a write failure even when the cached value now matches', async () => {
    const registry = parseRegistry(JSON.stringify({ version: 2, panes: { existing: EXISTING } }))
    const write = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
    const mutations = new CodexPaneAccountRegistryMutations({ read: () => registry, write })

    mutations.record('spawned', SPAWNED)
    await vi.advanceTimersByTimeAsync(100)

    expect(write).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retries a failed reconciliation write without a pending pane mutation', async () => {
    const registry = parseRegistry(JSON.stringify({ version: 2, panes: { existing: EXISTING } }))
    const write = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
    const mutations = new CodexPaneAccountRegistryMutations({ read: () => registry, write })

    mutations.persistReconciliation(registry, true)
    await vi.advanceTimersByTimeAsync(100)

    expect(write).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
})
