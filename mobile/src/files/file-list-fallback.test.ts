import { describe, expect, it } from 'vitest'
import { directoryCacheFromFileList, isMobileMethodUnavailableError } from './file-list-fallback'
import { getDirectoryCacheState } from './file-tree'

describe('isMobileMethodUnavailableError', () => {
  it('detects old-desktop allowlist and missing-method failures', () => {
    expect(isMobileMethodUnavailableError('forbidden', undefined)).toBe(true)
    expect(isMobileMethodUnavailableError('method_not_found', undefined)).toBe(true)
    expect(
      isMobileMethodUnavailableError(
        'some_code',
        "Method 'files.readDir' is not available to mobile clients"
      )
    ).toBe(true)
    expect(isMobileMethodUnavailableError('internal', 'boom')).toBe(false)
    expect(isMobileMethodUnavailableError(undefined, undefined)).toBe(false)
  })
})

describe('directoryCacheFromFileList', () => {
  it('synthesizes every ancestor directory from flat paths', () => {
    const cache = directoryCacheFromFileList([
      { relativePath: 'src/lib/util.ts', basename: 'util.ts', kind: 'text' },
      { relativePath: 'src/app.ts', basename: 'app.ts', kind: 'text' },
      { relativePath: 'README.md', basename: 'README.md', kind: 'text' }
    ])
    expect(cache['']?.entries).toEqual(
      expect.arrayContaining([
        { name: 'src', isDirectory: true },
        { name: 'README.md', isDirectory: false }
      ])
    )
    expect(cache['src']?.entries).toEqual(
      expect.arrayContaining([
        { name: 'lib', isDirectory: true },
        { name: 'app.ts', isDirectory: false }
      ])
    )
    expect(cache['src/lib']?.entries).toEqual([{ name: 'util.ts', isDirectory: false }])
  })

  it('keeps a name a directory when it appears as both file and dir prefix', () => {
    const cache = directoryCacheFromFileList([
      { relativePath: 'src', basename: 'src', kind: 'text' },
      { relativePath: 'src/app.ts', basename: 'app.ts', kind: 'text' }
    ])
    expect(cache['']?.entries).toEqual([{ name: 'src', isDirectory: true }])
  })

  it('returns an empty root for an empty list', () => {
    const cache = directoryCacheFromFileList([])
    expect(cache['']?.entries).toEqual([])
  })

  it('stores a __proto__ directory as an own key instead of mutating the prototype', () => {
    const cache = directoryCacheFromFileList([
      { relativePath: '__proto__/pollute.js', basename: 'pollute.js', kind: 'text' }
    ])
    expect(Object.getPrototypeOf(cache)).toBe(Object.prototype)
    expect(cache['']?.entries).toEqual([{ name: '__proto__', isDirectory: true }])
    expect(getDirectoryCacheState(cache, '__proto__')?.entries).toEqual([
      { name: 'pollute.js', isDirectory: false }
    ])
  })
})
