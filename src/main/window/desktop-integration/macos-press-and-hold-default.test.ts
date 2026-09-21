import { describe, expect, it } from 'vitest'

import { isOwnPreferencesDomain } from './macos-press-and-hold-default'

describe('isOwnPreferencesDomain', () => {
  it('accepts any bundle-supplied domain and rejects the shared unpackaged one', () => {
    expect(isOwnPreferencesDomain('com.stablyai.orca')).toBe(true)
    // Why: a renamed build signs its own Info.plist, so the domain is its own to write.
    expect(isOwnPreferencesDomain('com.example.fork')).toBe(true)
    expect(isOwnPreferencesDomain('com.github.Electron')).toBe(false)
    expect(isOwnPreferencesDomain('')).toBe(false)
  })
})
