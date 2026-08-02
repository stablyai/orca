import { describe, expect, it } from 'vitest'
import {
  flattenDirectoryCache,
  getMobileFileKind,
  isMarkdownPath,
  shouldIncludeMobileFileExplorerEntry,
  type DirectoryCache,
  type MobileDirEntry
} from './file-tree'

function entry(name: string, isDirectory = false, isSymlink = false): MobileDirEntry {
  return { name, isDirectory, isSymlink }
}

describe('file-tree', () => {
  it('flattens cached directories lazily with directories before files', () => {
    const cache: DirectoryCache = {
      '': { entries: [entry('zeta.txt'), entry('src', true), entry('readme.md')] },
      src: { entries: [entry('app.ts'), entry('lib', true)] },
      'src/lib': { entries: [entry('util.ts')] }
    }

    const collapsed = flattenDirectoryCache(cache, new Set())
    expect(collapsed.map((row) => row.id)).toEqual(['dir:src', 'file:readme.md', 'file:zeta.txt'])

    const expanded = flattenDirectoryCache(cache, new Set(['src', 'src/lib']))
    expect(expanded.map((row) => row.id)).toEqual([
      'dir:src',
      'dir:src/lib',
      'file:src/lib/util.ts',
      'file:src/app.ts',
      'file:readme.md',
      'file:zeta.txt'
    ])
  })

  it('mirrors desktop default browse exclusions while keeping dotfiles visible', () => {
    const cache: DirectoryCache = {
      '': {
        entries: [
          entry('.git', true),
          entry('.env'),
          entry('node_modules', true),
          entry('src', true)
        ]
      }
    }

    expect(flattenDirectoryCache(cache, new Set()).map((row) => row.id)).toEqual([
      'dir:src',
      'file:.env'
    ])
    expect(shouldIncludeMobileFileExplorerEntry(entry('.config', true))).toBe(true)
  })

  it('renders inline loading and error rows under expanded directories', () => {
    const cache: DirectoryCache = {
      '': { entries: [entry('loading-dir', true), entry('error-dir', true)] },
      'loading-dir': { entries: [], loading: true },
      'error-dir': { entries: [], error: 'permission denied' }
    }

    const rows = flattenDirectoryCache(cache, new Set(['loading-dir', 'error-dir']))
    expect(rows.map((row) => row.id)).toEqual([
      'dir:error-dir',
      'error:error-dir',
      'dir:loading-dir',
      'loading:loading-dir'
    ])
    expect(rows.find((row) => row.id === 'error:error-dir')).toMatchObject({
      kind: 'error',
      message: 'permission denied'
    })
  })

  it('preserves symlink metadata for user-initiated activation', () => {
    const cache: DirectoryCache = {
      '': { entries: [entry('linked-docs', false, true)] }
    }

    expect(flattenDirectoryCache(cache, new Set())).toEqual([
      {
        id: 'file:linked-docs',
        name: 'linked-docs',
        relativePath: 'linked-docs',
        depth: 0,
        kind: 'text',
        isSymlink: true
      }
    ])
  })

  it('does not treat inherited object keys as loaded directories', () => {
    const cache: DirectoryCache = {
      '': { entries: [entry('constructor', true), entry('__proto__', true)] },
      ['__proto__']: { entries: [entry('file.txt')] }
    }

    expect(
      flattenDirectoryCache(cache, new Set(['constructor', '__proto__'])).map((row) => row.id)
    ).toEqual(['dir:__proto__', 'file:__proto__/file.txt', 'dir:constructor'])
  })

  it('classifies binary file paths for existing mobile preview behavior', () => {
    expect(getMobileFileKind('assets/logo.png')).toBe('binary')
    expect(getMobileFileKind('src/app.ts')).toBe('text')
  })

  it('detects markdown paths', () => {
    expect(isMarkdownPath('docs/readme.md')).toBe(true)
    expect(isMarkdownPath('notes.markdown')).toBe(true)
    expect(isMarkdownPath('app.ts')).toBe(false)
  })
})
