import { describe, expect, it } from 'vitest'
import type {
  GlassesBridge,
  GlassesDeviceSnapshot,
  HudPageBuild,
  HudTextUpgrade,
  StartupBuildResult
} from '../glasses/glasses-bridge'
import type { GlassesHostProfile } from '../state/hud-store'
import { HostProfileStore } from './host-profile-store'

class FakeGlassesBridge implements GlassesBridge {
  private store = new Map<string, string>()

  async createStartUpPage(_page: HudPageBuild): Promise<StartupBuildResult> {
    return 'success'
  }
  async rebuildPage(_page: HudPageBuild): Promise<boolean> {
    return true
  }
  async upgradeText(_update: HudTextUpgrade): Promise<boolean> {
    return true
  }
  async shutDownPage(_exitMode: 0 | 1): Promise<boolean> {
    return true
  }
  async getDeviceSnapshot(): Promise<GlassesDeviceSnapshot | null> {
    return null
  }
  async setStoredValue(key: string, value: string): Promise<boolean> {
    if (value === '') {
      this.store.delete(key)
    } else {
      this.store.set(key, value)
    }
    return true
  }
  async getStoredValue(key: string): Promise<string> {
    return this.store.get(key) ?? ''
  }
  onRawEvent(): () => void {
    return () => {}
  }
  onDeviceStatusChanged(): () => void {
    return () => {}
  }

  // Test-only escape hatch to inject raw (possibly corrupt) storage content.
  seedRaw(key: string, value: string): void {
    this.store.set(key, value)
  }
}

const profileA: GlassesHostProfile = {
  id: 'host-a',
  name: 'Desktop A',
  endpoint: 'ws://192.168.1.10:6768',
  deviceToken: 'token-a',
  publicKeyB64: 'pk-a',
  lastConnected: 1000
}

const profileB: GlassesHostProfile = {
  id: 'host-b',
  name: 'Desktop B',
  endpoint: 'ws://192.168.1.11:6768',
  deviceToken: 'token-b',
  publicKeyB64: 'pk-b',
  lastConnected: 2000
}

describe('HostProfileStore', () => {
  it('returns an empty list when nothing is stored', async () => {
    const store = new HostProfileStore(new FakeGlassesBridge())
    expect(await store.load()).toEqual([])
  })

  it('persists upserted profiles across load() calls', async () => {
    const bridge = new FakeGlassesBridge()
    const store = new HostProfileStore(bridge)
    await store.upsert(profileA)
    await store.upsert(profileB)
    expect(await store.load()).toEqual([profileA, profileB])
  })

  it('upsert replaces an existing profile with the same id', async () => {
    const bridge = new FakeGlassesBridge()
    const store = new HostProfileStore(bridge)
    await store.upsert(profileA)
    const updated = { ...profileA, name: 'Renamed', lastConnected: 9999 }
    await store.upsert(updated)
    expect(await store.load()).toEqual([updated])
  })

  it('remove() drops only the matching profile', async () => {
    const bridge = new FakeGlassesBridge()
    const store = new HostProfileStore(bridge)
    await store.upsert(profileA)
    await store.upsert(profileB)
    await store.remove(profileA.id)
    expect(await store.load()).toEqual([profileB])
  })

  it('writes empty string when the last profile is removed', async () => {
    const bridge = new FakeGlassesBridge()
    const store = new HostProfileStore(bridge)
    await store.upsert(profileA)
    await store.remove(profileA.id)
    expect(await bridge.getStoredValue('orca.hostProfiles.v1')).toBe('')
    expect(await store.load()).toEqual([])
  })

  it('treats corrupt JSON as an empty list rather than throwing', async () => {
    const bridge = new FakeGlassesBridge()
    bridge.seedRaw('orca.hostProfiles.v1', '{not-json')
    const store = new HostProfileStore(bridge)
    expect(await store.load()).toEqual([])
  })

  it('treats schema-invalid JSON (e.g. a plain object) as an empty list', async () => {
    const bridge = new FakeGlassesBridge()
    bridge.seedRaw('orca.hostProfiles.v1', JSON.stringify({ not: 'an array' }))
    const store = new HostProfileStore(bridge)
    expect(await store.load()).toEqual([])
  })
})
