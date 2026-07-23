import { describe, expect, it } from 'vitest'
import {
  directoryCacheFromFileList,
  isMobileMethodUnavailableError,
  LEGACY_MOBILE_FILE_CACHE_MAX_DIRECTORIES,
  LEGACY_MOBILE_FILE_CACHE_MAX_ENTRIES,
  LEGACY_MOBILE_FILE_CACHE_MAX_RETAINED_BYTES,
  LEGACY_MOBILE_FILE_LIST_LIMIT_MESSAGE,
  LEGACY_MOBILE_FILE_LIST_MAX_FILES,
  LEGACY_MOBILE_FILE_PATH_MAX_BYTES,
  LEGACY_MOBILE_FILE_PATH_MAX_DEPTH,
  type LegacyMobileFileEntry
} from './file-list-fallback'
import { getDirectoryCacheState } from './file-tree'

const RETAINED_NODE_ESTIMATE_BYTES = 64

function file(relativePath: string): LegacyMobileFileEntry {
  return { relativePath, basename: relativePath, kind: 'text' }
}

function directoryChainPath(prefix: string, directories: number): string {
  const names = Array.from({ length: directories }, (_, index) => (index === 0 ? prefix : 'd'))
  return `${names.join('/')}/file`
}

function fixedLengthUniqueName(index: number, length: number): string {
  const suffix = `-${index.toString(36)}`
  return `${'x'.repeat(length - suffix.length)}${suffix}`
}

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
      file('src/lib/util.ts'),
      file('src/app.ts'),
      file('README.md')
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

  it('preserves empty-segment filtering and first-seen entry order', () => {
    const cache = directoryCacheFromFileList([
      file('//src///lib//util.ts//'),
      file('/README.md'),
      file('src/app.ts'),
      file('///')
    ])

    expect(cache['']?.entries).toEqual([
      { name: 'src', isDirectory: true },
      { name: 'README.md', isDirectory: false }
    ])
    expect(cache['src']?.entries).toEqual([
      { name: 'lib', isDirectory: true },
      { name: 'app.ts', isDirectory: false }
    ])
    expect(cache['src/lib']?.entries).toEqual([{ name: 'util.ts', isDirectory: false }])
  })

  it('keeps a name a directory when it appears as both file and dir prefix', () => {
    const cache = directoryCacheFromFileList([file('src'), file('src/app.ts')])
    expect(cache['']?.entries).toEqual([{ name: 'src', isDirectory: true }])
  })

  it('returns an empty root for an empty list', () => {
    const cache = directoryCacheFromFileList([])
    expect(cache['']?.entries).toEqual([])
  })

  it('stores a __proto__ directory as an own key instead of mutating the prototype', () => {
    const cache = directoryCacheFromFileList([file('__proto__/pollute.js')])
    expect(Object.getPrototypeOf(cache)).toBe(Object.prototype)
    expect(cache['']?.entries).toEqual([{ name: '__proto__', isDirectory: true }])
    expect(getDirectoryCacheState(cache, '__proto__')?.entries).toEqual([
      { name: 'pollute.js', isDirectory: false }
    ])
  })

  it('accepts a delimiter-heavy path at the exact byte cap without retaining empty segments', () => {
    const cache = directoryCacheFromFileList([file('/'.repeat(LEGACY_MOBILE_FILE_PATH_MAX_BYTES))])
    expect(cache['']?.entries).toEqual([])
  })

  it('measures the per-file path cap in UTF-8 bytes and rejects one byte over', () => {
    const exactPath = 'é'.repeat(LEGACY_MOBILE_FILE_PATH_MAX_BYTES / 2)
    expect(directoryCacheFromFileList([file(exactPath)])['']?.entries).toEqual([
      { name: exactPath, isDirectory: false }
    ])
    expect(() => directoryCacheFromFileList([file(`${exactPath}a`)])).toThrow(
      LEGACY_MOBILE_FILE_LIST_LIMIT_MESSAGE
    )
  })

  it('accepts the exact path depth and rejects the next segment', () => {
    const exactPath = Array.from({ length: LEGACY_MOBILE_FILE_PATH_MAX_DEPTH }, () => 'd').join('/')
    const parentPath = exactPath.slice(0, exactPath.lastIndexOf('/'))
    expect(
      getDirectoryCacheState(directoryCacheFromFileList([file(exactPath)]), parentPath)
    ).toEqual({
      entries: [{ name: 'd', isDirectory: false }]
    })
    expect(() => directoryCacheFromFileList([file(`${exactPath}/overflow`)])).toThrow(
      LEGACY_MOBILE_FILE_LIST_LIMIT_MESSAGE
    )
  })

  it('rejects a response above the desktop files.list record cap', () => {
    const files = Array.from({ length: LEGACY_MOBILE_FILE_LIST_MAX_FILES + 1 }, () => file(''))
    expect(() => directoryCacheFromFileList(files)).toThrow(LEGACY_MOBILE_FILE_LIST_LIMIT_MESSAGE)
  })

  it('accepts the exact directory cap and rejects one additional directory', () => {
    const fullChains = Math.floor((LEGACY_MOBILE_FILE_CACHE_MAX_DIRECTORIES - 1) / 255)
    const remainingDirectories = LEGACY_MOBILE_FILE_CACHE_MAX_DIRECTORIES - 1 - fullChains * 255
    const files = Array.from({ length: fullChains }, (_, index) =>
      file(directoryChainPath(`root-${index}`, 255))
    )
    if (remainingDirectories > 0) {
      files.push(file(directoryChainPath('tail', remainingDirectories)))
    }

    expect(Object.keys(directoryCacheFromFileList(files))).toHaveLength(
      LEGACY_MOBILE_FILE_CACHE_MAX_DIRECTORIES
    )
    expect(() =>
      directoryCacheFromFileList([...files, file(directoryChainPath('overflow', 1))])
    ).toThrow(LEGACY_MOBILE_FILE_LIST_LIMIT_MESSAGE)
  })

  it('accepts the exact aggregate entry cap and rejects one additional entry', () => {
    const exactFiles = Array.from({ length: LEGACY_MOBILE_FILE_LIST_MAX_FILES }, (_, index) =>
      file(`root-${index}/a/b/file`)
    )
    const overflowFiles = exactFiles.map((entry, index) =>
      index === 0 ? file('root-0/a/b/c/file') : entry
    )

    const cache = directoryCacheFromFileList(exactFiles)
    const entryCount = Object.values(cache).reduce(
      (total, state) => total + (state?.entries.length ?? 0),
      0
    )
    expect(entryCount).toBe(LEGACY_MOBILE_FILE_CACHE_MAX_ENTRIES)
    expect(() => directoryCacheFromFileList(overflowFiles)).toThrow(
      LEGACY_MOBILE_FILE_LIST_LIMIT_MESSAGE
    )
  })

  it('accepts the exact retained-byte budget and rejects two bytes over', () => {
    const namesBytes =
      LEGACY_MOBILE_FILE_CACHE_MAX_RETAINED_BYTES -
      RETAINED_NODE_ESTIMATE_BYTES -
      LEGACY_MOBILE_FILE_LIST_MAX_FILES * RETAINED_NODE_ESTIMATE_BYTES
    const namesCharacters = namesBytes / 2
    const baseLength = Math.floor(namesCharacters / LEGACY_MOBILE_FILE_LIST_MAX_FILES)
    const longerNames = namesCharacters % LEGACY_MOBILE_FILE_LIST_MAX_FILES
    const exactFiles = Array.from({ length: LEGACY_MOBILE_FILE_LIST_MAX_FILES }, (_, index) => {
      const length = baseLength + (index < longerNames ? 1 : 0)
      return file(fixedLengthUniqueName(index, length))
    })
    const overflowFiles = exactFiles.map((entry, index) =>
      index === 0 ? file(`${entry.relativePath}x`) : entry
    )

    expect(directoryCacheFromFileList(exactFiles)['']?.entries).toHaveLength(
      LEGACY_MOBILE_FILE_LIST_MAX_FILES
    )
    expect(() => directoryCacheFromFileList(overflowFiles)).toThrow(
      LEGACY_MOBILE_FILE_LIST_LIMIT_MESSAGE
    )
  })

  it('rejects malformed legacy response shapes with a clear error', () => {
    expect(() => directoryCacheFromFileList({ files: [] })).toThrow('invalid legacy file list')
    expect(() => directoryCacheFromFileList([{ relativePath: 42 }])).toThrow(
      'invalid legacy file list'
    )
  })
})
