import { describe, expect, it, vi } from 'vitest'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { AgentHookInstallStatusSnapshotStore } from './install-status-snapshot-store'

function status(state: AgentHookInstallStatus['state']): AgentHookInstallStatus {
  return {
    agent: 'claude',
    state,
    configPath: '/home/test/.claude/settings.json',
    managedHooksPresent: state === 'installed',
    detail: null
  }
}

describe('AgentHookInstallStatusSnapshotStore', () => {
  it('distinguishes unavailable, fresh missing, and stale last-known values', () => {
    let now = 10
    const store = new AgentHookInstallStatusSnapshotStore(() => now)

    expect(store.read('claude')).toMatchObject({
      value: null,
      stale: true,
      age: null,
      availability: 'unavailable'
    })

    store.publish(status('not_installed'))
    expect(store.read('claude')).toMatchObject({
      state: 'not_installed',
      value: status('not_installed'),
      stale: false,
      age: 0,
      availability: 'missing'
    })

    now = 20
    store.invalidate('claude', new Error('offline'))
    expect(store.read('claude')).toMatchObject({
      state: 'not_installed',
      stale: true,
      age: 10,
      availability: 'unavailable',
      lastError: 'offline'
    })
  })

  it('fences a late refresh behind a newer mutation', async () => {
    const store = new AgentHookInstallStatusSnapshotStore(() => 10)
    let resolveRefresh: (value: AgentHookInstallStatus) => void = () => {}
    const refresh = store.refresh(
      'claude',
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve
        })
    )
    await Promise.resolve()

    store.publish(status('installed'))
    resolveRefresh(status('not_installed'))

    await expect(refresh).resolves.toMatchObject({
      state: 'installed',
      value: status('installed'),
      stale: false,
      availability: 'ready'
    })
  })

  it('deduplicates concurrent refreshes and preserves a value after failure', async () => {
    const store = new AgentHookInstallStatusSnapshotStore(() => 10)
    store.publish(status('installed'))
    const reader = vi.fn().mockRejectedValue(new Error('share unavailable'))

    const first = store.refresh('claude', reader)
    const second = store.refresh('claude', reader)

    expect(first).toBe(second)
    await expect(first).resolves.toMatchObject({
      state: 'installed',
      stale: true,
      availability: 'unavailable',
      lastError: 'share unavailable'
    })
    expect(reader).toHaveBeenCalledTimes(1)
  })

  it('isolates execution-host scopes', () => {
    const store = new AgentHookInstallStatusSnapshotStore()
    store.publish(status('installed'), 'ssh:a')

    expect(store.read('claude', 'ssh:a').state).toBe('installed')
    expect(store.read('claude', 'ssh:b').availability).toBe('unavailable')
    expect(store.read('claude').availability).toBe('unavailable')
  })

  it('classifies permission failures as denied', async () => {
    const store = new AgentHookInstallStatusSnapshotStore()
    const error = Object.assign(new Error('permission denied'), { code: 'EACCES' })

    await store.refresh('claude', () => Promise.reject(error))

    expect(store.read('claude')).toMatchObject({
      value: null,
      stale: true,
      availability: 'denied',
      lastError: 'permission denied'
    })
  })
})
