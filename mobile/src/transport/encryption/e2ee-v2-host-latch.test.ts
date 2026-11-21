import AsyncStorage from '@react-native-async-storage/async-storage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(), setItem: vi.fn() }
}))

const stored = new Map<string, string>()

import { createDirectE2EEFramingPolicy } from './direct-e2ee-framing-policy'
import {
  hydrateE2EEV2HostLatch,
  isHostLatchedToE2EEV2,
  resetE2EEV2HostLatchForTests
} from './e2ee-v2-host-latch'

describe('E2EE v2 host latch', () => {
  beforeEach(() => {
    resetE2EEV2HostLatchForTests()
    stored.clear()
    vi.mocked(AsyncStorage.getItem)
      .mockReset()
      .mockImplementation(async (key) => stored.get(key) ?? null)
    vi.mocked(AsyncStorage.setItem)
      .mockReset()
      .mockImplementation(async (key, value) => {
        stored.set(key, value)
      })
  })

  it('reports unknown until hydrated, so a refused hello cannot fall back yet', async () => {
    let release!: (value: string | null) => void
    vi.mocked(AsyncStorage.getItem).mockReturnValue(new Promise((resolve) => (release = resolve)))
    const policy = createDirectE2EEFramingPolicy('host-key')
    policy.noteV2HelloRefused()
    expect(isHostLatchedToE2EEV2('host-key')).toBeNull()
    expect(policy.framingForNextDial()).toBe('v2')

    release(null)
    await hydrateE2EEV2HostLatch()
    expect(policy.framingForNextDial()).toBe('legacy')
  })

  it('keeps unreadable storage unknown (no fallback) and retries the read', async () => {
    vi.mocked(AsyncStorage.getItem)
      .mockRejectedValueOnce(new Error('transient read failure'))
      .mockResolvedValueOnce(JSON.stringify(['host-key']))
    const policy = createDirectE2EEFramingPolicy('host-key')
    await hydrateE2EEV2HostLatch()
    expect(isHostLatchedToE2EEV2('host-key')).toBeNull()
    policy.noteV2HelloRefused()
    expect(policy.framingForNextDial()).toBe('v2')
    expect(policy.helloRefusalIsAuthFailure()).toBe(false)

    await hydrateE2EEV2HostLatch()
    expect(isHostLatchedToE2EEV2('host-key')).toBe(true)
    expect(policy.framingForNextDial()).toBe('v2')
    expect(policy.helloRefusalIsAuthFailure()).toBe(true)
  })
})
