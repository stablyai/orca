import { describe, expect, it, vi } from 'vitest'

// The module pulls in expo-file-system at import time; only the pure converter is under test here.
vi.mock('expo-file-system', () => ({
  Directory: class {},
  File: class {},
  Paths: { cache: '' }
}))

import { generationDirectoryPath } from './generation-store-file-system'

describe('generationDirectoryPath', () => {
  it('hands the native view the absolute path both loaders demand', () => {
    // Both refuse anything without a leading slash, and the store speaks file:// uris.
    expect(
      generationDirectoryPath('file:///var/mobile/Caches/mobile-web/abc/generations/def')
    ).toBe('/var/mobile/Caches/mobile-web/abc/generations/def')
    expect(generationDirectoryPath('file:///data/user/0/com.stably.orca.mobile/cache/mw')).toBe(
      '/data/user/0/com.stably.orca.mobile/cache/mw'
    )
  })

  it('decodes what a uri escaped and a path spells literally', () => {
    expect(generationDirectoryPath('file:///var/Orca%20Mobile/mobile-web')).toBe(
      '/var/Orca Mobile/mobile-web'
    )
  })

  it('leaves a value that is already a path alone, so nobody can decode one twice', () => {
    expect(generationDirectoryPath('/var/mobile/Caches/100%25')).toBe('/var/mobile/Caches/100%25')
  })
})
