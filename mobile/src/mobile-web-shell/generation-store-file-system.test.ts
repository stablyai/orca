import { beforeEach, describe, expect, it, vi } from 'vitest'

// Model only the directory calls the store root and its migration make, over a set of existing paths.
const disk = vi.hoisted((): { directories: Set<string>; excludedFromBackup: string[] } => ({
  directories: new Set(),
  excludedFromBackup: []
}))

vi.mock('../../modules/orca-mobile-web-shell/src', () => ({
  excludeFromBackup: async (path: string) => {
    disk.excludedFromBackup.push(path)
  }
}))

vi.mock('expo-file-system', () => {
  class Directory {
    uri: string
    constructor(...segments: (string | Directory)[]) {
      this.uri = segments
        .map((segment) => (typeof segment === 'string' ? segment : segment.uri))
        .join('/')
    }
    get exists(): boolean {
      return disk.directories.has(this.uri)
    }
    move(to: Directory): void {
      disk.directories.delete(this.uri)
      disk.directories.add(to.uri)
    }
    delete(): void {
      disk.directories.delete(this.uri)
    }
    create(): void {
      disk.directories.add(this.uri)
    }
  }
  return {
    Directory,
    File: class {
      exists = false
    },
    Paths: { cache: 'file:///app/cache', document: 'file:///app/files' }
  }
})

import {
  createExpoGenerationFileSystem,
  generationDirectoryPath
} from './generation-store-file-system'

const LEGACY_ROOT = 'file:///app/cache/mobile-web'
const ROOT = 'file:///app/files/mobile-web'

describe('the store root', () => {
  beforeEach(() => {
    disk.directories.clear()
    disk.excludedFromBackup = []
  })

  it('keeps the store root out of device backups', () => {
    createExpoGenerationFileSystem()
    expect(disk.excludedFromBackup).toEqual(['/app/files/mobile-web'])
  })

  it('adopts the tree an earlier build kept in the cache directory', () => {
    disk.directories.add(LEGACY_ROOT)
    createExpoGenerationFileSystem()
    expect([...disk.directories]).toEqual([ROOT])
  })

  it('deletes the old tree rather than merge it into a store that already exists', () => {
    disk.directories.add(LEGACY_ROOT)
    disk.directories.add(ROOT)
    createExpoGenerationFileSystem()
    expect([...disk.directories]).toEqual([ROOT])
  })
})

describe('generationDirectoryPath', () => {
  it('hands the native view the absolute path both loaders demand', () => {
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
