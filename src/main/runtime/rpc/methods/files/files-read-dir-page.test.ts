import { describe, expect, it, vi } from 'vitest'

import type { DirEntry } from '../../../../../shared/file-listing/directory-entry'
import type { DirEntryCursor } from '../../../../../shared/file-listing/file-dir-page'

import { DirListingPageCache } from './files-read-dir-page'

const fileNamed = (name: string): DirEntry => ({ name, isDirectory: false, isSymlink: false })
const folder = (count: number, prefix = 'file'): DirEntry[] =>
  Array.from({ length: count }, (_, index) =>
    fileNamed(`${prefix}-${String(index).padStart(6, '0')}.txt`)
  )
const cursorOf = (entry: DirEntry): DirEntryCursor => ({
  name: entry.name,
  isDirectory: entry.isDirectory
})
const names = (entries: DirEntry[]): string[] => entries.map((entry) => entry.name)

const REQUEST = { worktree: 'id:wt-1', relativePath: 'big' }

/** Reads a folder to its end the way the explorer does: each page starts after the last. */
async function readAll(
  cache: DirListingPageCache,
  list: () => Promise<DirEntry[]>,
  limit: number,
  betweenPages: (pageIndex: number) => void = () => {}
): Promise<string[]> {
  const read: string[] = []
  let after: DirEntryCursor | undefined
  for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
    const page = await cache.readPage('socket-1', { ...REQUEST, after, limit }, list)
    read.push(...names(page.entries))
    const last = page.entries.at(-1)
    if (!page.hasMore || !last) {
      return read
    }
    after = cursorOf(last)
    betweenPages(pageIndex)
  }
  throw new Error('never reached the end of the folder')
}

describe('DirListingPageCache', () => {
  it('does not serve a file deleted after the cursor once the watcher reports the change', async () => {
    let entries = folder(6)
    const cache = new DirListingPageCache(() => 0)
    const list = vi.fn(async () => entries)
    const read = await readAll(cache, list, 2, (pageIndex) => {
      if (pageIndex === 0) {
        entries = entries.filter((entry) => entry.name !== 'file-000004.txt')
        cache.forgetWorkspace(REQUEST.worktree)
      }
    })
    expect(read).not.toContain('file-000004.txt')
    expect(read).toHaveLength(5)
  })

  it('places a cursor whose entry was since deleted, folders before files', async () => {
    const cache = new DirListingPageCache(() => 0)
    const entries = [{ name: 'src', isDirectory: true, isSymlink: false }, ...folder(3)]
    const page = await cache.readPage(
      'socket-1',
      { ...REQUEST, after: { name: 'zzz-gone', isDirectory: true }, limit: 10 },
      async () => entries
    )
    expect(names(page.entries)).toEqual(names(folder(3)))
  })
})
