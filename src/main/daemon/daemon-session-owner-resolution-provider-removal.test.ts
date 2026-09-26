import { describe, expect, it, vi } from 'vitest'
import type { IPtyProvider, PtyProcessInfo } from '../providers/types'
import { DaemonSessionOwnerResolver } from './daemon-session-owner-resolution'

function provider(processes: () => Promise<PtyProcessInfo[]>): IPtyProvider {
  return { listProcesses: vi.fn(processes) } as unknown as IPtyProvider
}

describe('DaemonSessionOwnerResolver.removeProvider', () => {
  it('stops polling a retired provider so inventory can complete without it', async () => {
    const surviving = provider(async () => [{ id: 'held', cwd: '', title: '' }])
    const retiring = provider(async () => {
      throw new Error('adapter disposed')
    })
    const routes = new Map<string, IPtyProvider>()
    const resolver = new DaemonSessionOwnerResolver([surviving, retiring], routes)

    // Why: before removal, the disposed provider's rejection keeps inventory
    // permanently incomplete, which degrades every later ownership resolution to
    // 'unknown' -- the exact regression retireLegacyAdapter() must not introduce.
    const before = await resolver.resolve('held')
    expect(before).toEqual({ kind: 'unknown' })

    resolver.removeProvider(retiring)

    const after = await resolver.resolve('held')
    expect(after).toEqual({ kind: 'owner', provider: surviving })
  })

  it('forgets any route already recorded for the removed provider', async () => {
    const surviving = provider(async () => [])
    const retiring = provider(async () => [])
    const routes = new Map<string, IPtyProvider>([['stale-session', retiring]])
    const resolver = new DaemonSessionOwnerResolver([surviving, retiring], routes)

    resolver.removeProvider(retiring)

    expect(routes.has('stale-session')).toBe(false)
  })

  it('is a no-op for a provider that was never tracked', () => {
    const only = provider(async () => [])
    const stranger = provider(async () => [])
    const resolver = new DaemonSessionOwnerResolver([only], new Map())
    expect(() => resolver.removeProvider(stranger)).not.toThrow()
  })
})
