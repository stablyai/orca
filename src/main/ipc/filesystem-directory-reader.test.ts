import { describe, expect, it } from 'vitest'
import { FILESYSTEM_DIRECTORY_LIMIT_MESSAGE } from '../../shared/filesystem-directory-listing-limit'
import { collectLocalFilesystemDirectoryEntries } from './filesystem-directory-reader'

type TestEntryOptions = {
  name: string
  directory?: boolean
  symlink?: boolean
  onClassify?: () => void
}

function entry(options: TestEntryOptions) {
  return {
    name: options.name,
    isDirectory: () => {
      options.onClassify?.()
      return options.directory ?? false
    },
    isSymbolicLink: () => options.symlink ?? false
  }
}

describe('local filesystem directory reader', () => {
  it('preserves directory-first sorting and keeps symlinks file-like', async () => {
    const source = [
      entry({ name: 'z.txt' }),
      entry({ name: 'linked-dir', directory: true, symlink: true }),
      entry({ name: 'beta', directory: true }),
      entry({ name: 'alpha', directory: true })
    ]

    await expect(collectLocalFilesystemDirectoryEntries(source)).resolves.toEqual([
      { name: 'alpha', isDirectory: true, isSymlink: false },
      { name: 'beta', isDirectory: true, isSymlink: false },
      { name: 'linked-dir', isDirectory: false, isSymlink: true },
      { name: 'z.txt', isDirectory: false, isSymlink: false }
    ])
  })

  it('stops before classifying or retaining the first over-limit entry', async () => {
    let enumerated = 0
    let overLimitClassified = false
    const source = {
      async *[Symbol.asyncIterator]() {
        for (const value of [
          entry({ name: 'one' }),
          entry({ name: 'two' }),
          entry({ name: 'three', onClassify: () => (overLimitClassified = true) })
        ]) {
          enumerated += 1
          yield value
        }
      }
    }

    await expect(
      collectLocalFilesystemDirectoryEntries(source, {
        maxEntries: 2,
        maxRetainedBytes: 1024
      })
    ).rejects.toThrow(FILESYSTEM_DIRECTORY_LIMIT_MESSAGE)
    expect(enumerated).toBe(3)
    expect(overLimitClassified).toBe(false)
  })
})
