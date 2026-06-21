import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isSafeBrowserProfileDirectory, discoverProfiles } from './chromium-profile-discovery'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-prof-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('isSafeBrowserProfileDirectory', () => {
  it('rejects path traversal', () => {
    expect(isSafeBrowserProfileDirectory('..')).toBe(false)
    expect(isSafeBrowserProfileDirectory('a/b')).toBe(false)
    expect(isSafeBrowserProfileDirectory('Default')).toBe(true)
  })
})

describe('discoverProfiles', () => {
  it('falls back to Default when Local State is missing', () => {
    expect(discoverProfiles(dir)).toEqual([{ name: 'Default', directory: 'Default' }])
  })
})
