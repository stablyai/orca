import { describe, expect, it } from 'vitest'

import {
  ensureMacPressAndHoldDefault,
  isOwnPreferencesDomain,
  type PressAndHoldRecord
} from './macos-press-and-hold-default'

describe('isOwnPreferencesDomain', () => {
  it('accepts any bundle-supplied domain and rejects the shared unpackaged one', () => {
    expect(isOwnPreferencesDomain('com.stablyai.orca')).toBe(true)
    // Why: a renamed build signs its own Info.plist, so the domain is its own to write.
    expect(isOwnPreferencesDomain('com.example.fork')).toBe(true)
    expect(isOwnPreferencesDomain('com.github.Electron')).toBe(false)
    expect(isOwnPreferencesDomain('')).toBe(false)
  })
})

describe('ensureMacPressAndHoldDefault', () => {
  it('decides again for a renamed build that shares the same settings folder', () => {
    let stored: PressAndHoldRecord | null = {
      version: 1,
      decision: 'applied',
      domain: 'com.stablyai.orca',
      decidedAt: '2026-01-01T00:00:00.000Z'
    }
    const writes: { domain: string; value: boolean }[] = []

    const result = ensureMacPressAndHoldDefault({
      platform: 'darwin',
      resolveBundleIdentifier: () => 'com.example.fork',
      readRecord: () => stored,
      writeRecord: (record) => {
        stored = record
      },
      readDomainPreference: () => 'unset',
      writeDomainPreference: (domain, value) => {
        writes.push({ domain, value })
        return true
      },
      now: () => '2026-08-20T00:00:00.000Z'
    })

    expect(result).toBe('applied')
    expect(writes).toEqual([{ domain: 'com.example.fork', value: false }])
    expect(stored?.domain).toBe('com.example.fork')
  })
})
