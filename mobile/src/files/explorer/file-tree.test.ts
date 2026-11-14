import { describe, expect, it } from 'vitest'
import {
  filterDirectoryCache,
  flattenDirectoryCache,
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

  it('filters loaded folders by name and keeps the parents of nested matches', () => {
    const cache: DirectoryCache = {
      '': { entries: [entry('README.md'), entry('src', true), entry('node_modules', true)] },
      src: { entries: [entry('App.ts'), entry('lib', true)] },
      'src/lib': { entries: [entry('app-state.ts'), entry('other.ts')] },
      node_modules: { entries: [entry('app.js')] }
    }

    expect(filterDirectoryCache(cache, ' APP ').map((row) => row.id)).toEqual([
      'dir:src',
      'dir:src/lib',
      'file:src/lib/app-state.ts',
      'file:src/App.ts'
    ])
    expect(filterDirectoryCache(cache, 'missing')).toEqual([])
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
})
