import { describe, expect, it, vi } from 'vitest'
import { FILESYSTEM_DIRECTORY_LIMIT_MESSAGE } from '../shared/filesystem-directory-listing-limit'
import { collectRelayFilesystemDirectoryEntries } from './filesystem-directory-reader'

function entry(name: string, options?: { directory?: boolean; symlink?: boolean }) {
  return {
    name,
    isDirectory: () => options?.directory ?? false,
    isSymbolicLink: () => options?.symlink ?? false
  }
}

describe('relay filesystem directory reader', () => {
  it('preserves directory-first ordering and symlink-directory classification', async () => {
    const classify = vi.fn(async (_dirPath, source) =>
      source.isSymbolicLink() ? true : source.isDirectory()
    )

    await expect(
      collectRelayFilesystemDirectoryEntries(
        '/repo',
        [
          entry('z.txt'),
          entry('linked', { symlink: true }),
          entry('beta', { directory: true }),
          entry('alpha', { directory: true })
        ],
        undefined,
        classify
      )
    ).resolves.toEqual([
      { name: 'alpha', isDirectory: true, isSymlink: false },
      { name: 'beta', isDirectory: true, isSymlink: false },
      { name: 'linked', isDirectory: true, isSymlink: true },
      { name: 'z.txt', isDirectory: false, isSymlink: false }
    ])
    expect(classify).toHaveBeenCalledTimes(4)
  })

  it('stops before classifying or retaining the first over-limit entry', async () => {
    let enumerated = 0
    const classify = vi.fn(async () => false)
    const source = {
      async *[Symbol.asyncIterator]() {
        while (enumerated < 100) {
          enumerated += 1
          yield entry(`entry-${enumerated}`)
        }
      }
    }

    await expect(
      collectRelayFilesystemDirectoryEntries(
        '/repo',
        source,
        { maxEntries: 3, maxRetainedBytes: 1024 },
        classify
      )
    ).rejects.toThrow(FILESYSTEM_DIRECTORY_LIMIT_MESSAGE)
    expect(enumerated).toBe(4)
    expect(classify).toHaveBeenCalledTimes(3)
  })
})
