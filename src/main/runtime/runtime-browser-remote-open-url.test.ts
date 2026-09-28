import { describe, expect, it } from 'vitest'
import {
  admitRemoteOpenUrl,
  remoteOpenUrlTrackedHostCount
} from './runtime-browser-commands-browser-tab-create'

describe('admitRemoteOpenUrl', () => {
  it('admits a few opens per host and then refuses until the window passes', () => {
    const host = `ssh-${Math.random()}`
    expect([0, 1, 2].map((i) => admitRemoteOpenUrl(host, 1000 + i))).toEqual([true, true, true])
    expect(admitRemoteOpenUrl(host, 1500)).toBe(false)
    expect(admitRemoteOpenUrl(host, 1000 + 10_001)).toBe(true)
  })

  it('limits each host independently', () => {
    const a = `a-${Math.random()}`
    const b = `b-${Math.random()}`
    for (let i = 0; i < 3; i++) {
      admitRemoteOpenUrl(a, 50)
    }
    expect(admitRemoteOpenUrl(a, 60)).toBe(false)
    expect(admitRemoteOpenUrl(b, 60)).toBe(true)
  })

  it('forgets hosts that have been idle for a whole window', () => {
    const base = 1_000_000
    for (let i = 0; i < 20; i++) {
      admitRemoteOpenUrl(`idle-${i}`, base)
    }
    admitRemoteOpenUrl('active', base + 20_000)
    expect(remoteOpenUrlTrackedHostCount()).toBe(1)
  })
})
