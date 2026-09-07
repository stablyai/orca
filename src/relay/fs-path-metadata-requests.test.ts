import { beforeEach, describe, expect, it, vi } from 'vitest'

const { readdirMock, statMock } = vi.hoisted(() => ({
  readdirMock: vi.fn(),
  statMock: vi.fn()
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>
  return { ...original, readdir: readdirMock, stat: statMock }
})

import { readRelayDir } from './fs-path-metadata-requests'

function dirEntry(args: { name: string; directory?: boolean; symlink?: boolean }) {
  return {
    name: args.name,
    isDirectory: () => args.directory ?? false,
    isSymbolicLink: () => args.symlink ?? false
  }
}

describe('readRelayDir', () => {
  beforeEach(() => {
    readdirMock.mockReset()
    statMock.mockReset()
  })

  it('creates asynchronous classification work only for symlinks in a large listing', async () => {
    readdirMock.mockResolvedValue([
      ...Array.from({ length: 1_000 }, (_, index) => dirEntry({ name: `file-${index}.txt` })),
      dirEntry({ name: 'directory', directory: true }),
      dirEntry({ name: 'directory-link', symlink: true }),
      dirEntry({ name: 'file-link', symlink: true })
    ])
    statMock
      .mockResolvedValueOnce({ isDirectory: () => true })
      .mockResolvedValueOnce({ isDirectory: () => false })

    const originalAll = Promise.all.bind(Promise)
    let promiseBearingEntries = -1
    const allSpy = vi.spyOn(Promise, 'all').mockImplementation(((values: Iterable<unknown>) => {
      const entries = Array.from(values)
      promiseBearingEntries = entries.filter((entry) => entry instanceof Promise).length
      return originalAll(entries)
    }) as typeof Promise.all)

    try {
      const result = await readRelayDir({ dirPath: '/repo' })

      expect(result.slice(0, 2)).toEqual([
        { name: 'directory', isDirectory: true, isSymlink: false },
        { name: 'directory-link', isDirectory: true, isSymlink: true }
      ])
      expect(result.find((entry) => entry.name === 'file-link')).toEqual({
        name: 'file-link',
        isDirectory: false,
        isSymlink: true
      })
    } finally {
      allSpy.mockRestore()
    }

    expect(statMock).toHaveBeenCalledTimes(2)
    expect(promiseBearingEntries).toBe(2)
  })
})
