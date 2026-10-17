import { describe, expect, it, vi } from 'vitest'
import type { GlassesHostProfile } from '../state/hud-store'
import { ProfileController, type HostProfilePort } from './profile-controller'

function fakeStore(initial: GlassesHostProfile[] = []): HostProfilePort {
  let hosts = [...initial]
  return {
    load: vi.fn(async () => [...hosts]),
    upsert: vi.fn(async (profile: GlassesHostProfile) => {
      hosts = [...hosts.filter((h) => h.id !== profile.id), profile]
    }),
    remove: vi.fn(async (id: string) => {
      hosts = hosts.filter((h) => h.id !== id)
    })
  }
}

const profile: GlassesHostProfile = {
  id: 'host-1',
  name: 'desk',
  endpoint: 'ws://10.0.0.1:6768',
  deviceToken: 'tok',
  publicKeyB64: `${'a'.repeat(43)}=`,
  lastConnected: 0
}

describe('ProfileController', () => {
  it('delegates load() to the underlying store', async () => {
    const store = fakeStore([profile])
    const controller = new ProfileController(store)
    expect(await controller.load()).toEqual([profile])
  })

  it('emits an "upserted" event to subscribers after a successful upsert', async () => {
    const store = fakeStore()
    const controller = new ProfileController(store)
    const listener = vi.fn()
    controller.subscribe(listener)

    await controller.upsert(profile)

    expect(store.upsert).toHaveBeenCalledWith(profile)
    expect(listener).toHaveBeenCalledWith({ type: 'upserted', profile })
  })

  it('emits a "removed" event to subscribers after a successful remove', async () => {
    const store = fakeStore([profile])
    const controller = new ProfileController(store)
    const listener = vi.fn()
    controller.subscribe(listener)

    await controller.remove('host-1')

    expect(store.remove).toHaveBeenCalledWith('host-1')
    expect(listener).toHaveBeenCalledWith({ type: 'removed', id: 'host-1' })
  })

  it('stops notifying a listener after it unsubscribes', async () => {
    const store = fakeStore()
    const controller = new ProfileController(store)
    const listener = vi.fn()
    const unsubscribe = controller.subscribe(listener)
    unsubscribe()

    await controller.upsert(profile)

    expect(listener).not.toHaveBeenCalled()
  })

  it('notifies multiple independent subscribers', async () => {
    const store = fakeStore()
    const controller = new ProfileController(store)
    const a = vi.fn()
    const b = vi.fn()
    controller.subscribe(a)
    controller.subscribe(b)

    await controller.upsert(profile)

    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })
})
