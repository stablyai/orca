import { beforeEach, describe, expect, it, vi } from 'vitest'

const storage = vi.hoisted(() => new Map<string, string>())
const network = vi.hoisted(() => ({ type: 'WIFI', ip: '192.168.1.23' }))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => storage.get(key) ?? null,
    setItem: async (key: string, value: string) => void storage.set(key, value)
  }
}))
vi.mock('expo-network', () => ({
  NetworkStateType: { NONE: 'NONE', UNKNOWN: 'UNKNOWN', CELLULAR: 'CELLULAR' },
  getNetworkStateAsync: async () => ({ type: network.type, isConnected: true }),
  getIpAddressAsync: async () => network.ip
}))

import { lastGoodPathWasDirectHere, recordHostGoodPath } from './host-path-memory'

function joinNetwork(type: string, ip: string): void {
  network.type = type
  network.ip = ip
}

describe('host path memory', () => {
  beforeEach(() => {
    storage.clear()
    joinNetwork('WIFI', '192.168.1.23')
  })

  it('keeps the direct head start after a direct connection on the same network', async () => {
    await recordHostGoodPath('host-1', 'direct')
    joinNetwork('WIFI', '192.168.1.87')

    expect(await lastGoodPathWasDirectHere('host-1')).toBe(true)
  })

  it('drops the head start for a direct record from another network', async () => {
    await recordHostGoodPath('host-1', 'direct')
    joinNetwork('WIFI', '10.0.4.12')

    expect(await lastGoodPathWasDirectHere('host-1')).toBe(false)
  })

  it('drops the head start when the last good path was the relay', async () => {
    await recordHostGoodPath('host-1', 'relay')

    expect(await lastGoodPathWasDirectHere('host-1')).toBe(false)
  })

  it('drops the head start for a host with no record', async () => {
    await recordHostGoodPath('host-2', 'direct')

    expect(await lastGoodPathWasDirectHere('host-1')).toBe(false)
  })

  it('keeps a direct record made while a VPN hides the network type', async () => {
    joinNetwork('UNKNOWN', '192.168.1.23')
    await recordHostGoodPath('host-1', 'direct')

    expect(await lastGoodPathWasDirectHere('host-1')).toBe(true)
  })

  it('keeps a cellular direct record across carrier address changes', async () => {
    joinNetwork('CELLULAR', '100.64.12.9')
    await recordHostGoodPath('host-1', 'direct')
    joinNetwork('CELLULAR', '100.71.3.200')

    expect(await lastGoodPathWasDirectHere('host-1')).toBe(true)
  })
})
