import { describe, expect, it, vi } from 'vitest'

const { statMock } = vi.hoisted(() => ({ statMock: vi.fn() }))

vi.mock('node:fs/promises', () => ({ opendir: vi.fn(), stat: statMock }))

import { collectMobileRelayDirectoryEntries } from './mobile-file-directory-reader'

describe('mobile relay directory reader', () => {
  it('stops enumeration at the mobile entry limit', async () => {
    let enumerated = 0
    const directory = {
      async *[Symbol.asyncIterator]() {
        while (enumerated < 20_000) {
          enumerated += 1
          yield {
            name: 'entry',
            isDirectory: () => false,
            isSymbolicLink: () => false
          }
        }
      }
    }

    await expect(collectMobileRelayDirectoryEntries('/repo', directory)).rejects.toThrow(
      'This folder is too large to show safely on mobile'
    )
    expect(enumerated).toBe(10_001)
  })

  it('bounds concurrent symlink stat work while preserving entry order', async () => {
    let active = 0
    let maxActive = 0
    statMock.mockImplementation(async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise<void>((resolve) => setImmediate(resolve))
      active -= 1
      return { isDirectory: () => true }
    })
    const directory = {
      async *[Symbol.asyncIterator]() {
        for (let index = 0; index < 100; index += 1) {
          yield {
            name: `link-${index}`,
            isDirectory: () => false,
            isSymbolicLink: () => true
          }
        }
      }
    }

    const entries = await collectMobileRelayDirectoryEntries('/repo', directory)

    expect(maxActive).toBe(32)
    expect(entries.map((entry) => entry.name)).toEqual(
      Array.from({ length: 100 }, (_, index) => `link-${index}`)
    )
    expect(entries.every((entry) => entry.isDirectory && entry.isSymlink)).toBe(true)
  })
})
