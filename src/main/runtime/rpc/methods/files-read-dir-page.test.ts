import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { DirEntry } from '../../../../shared/filesystem-entry-types'
import type { DirEntryCursor } from '../../../../shared/file-dir-page'
import { FILE_METHODS } from './files'
import { DIR_LISTING_PAGE_CACHE_TTL_MS, DirListingPageCache } from './files-read-dir-page'

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
  it('lists once for page one and serves later pages after the cursor from that listing', async () => {
    const cache = new DirListingPageCache(() => 0)
    const list = vi.fn(async () => folder(5))

    expect(await readAll(cache, list, 2)).toEqual(names(folder(5)))
    expect(list).toHaveBeenCalledTimes(1)
    // The last page released the listing, so a later cursor read lists again.
    await cache.readPage('socket-1', { ...REQUEST, after: cursorOf(folder(5)[1]), limit: 2 }, list)
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('neither skips nor repeats an entry when one is deleted between pages', async () => {
    let entries = folder(6)
    const cache = new DirListingPageCache(() => 0)
    const list = vi.fn(async () => entries)
    const read = await readAll(cache, list, 2, (pageIndex) => {
      if (pageIndex === 0) {
        // file-000001 was already shown; the watcher drops the listing, so page two re-lists.
        entries = entries.filter((entry) => entry.name !== 'file-000001.txt')
        cache.forgetWorkspace(REQUEST.worktree)
      }
    })
    expect(read).toEqual(names(folder(6)))
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('stays in order when the listing expires mid-scroll and a file arrives before the cursor', async () => {
    let now = 0
    let entries = folder(6)
    const cache = new DirListingPageCache(() => now)
    const list = vi.fn(async () => entries)
    const read = await readAll(cache, list, 2, (pageIndex) => {
      if (pageIndex === 0) {
        entries = [fileNamed('file-000000-a.txt'), ...entries]
        now = DIR_LISTING_PAGE_CACHE_TTL_MS
      }
    })
    // The new file sorts before the cursor, so it waits for a refresh rather than shifting pages.
    expect(read).toEqual(names(folder(6)))
    expect(list).toHaveBeenCalledTimes(2)
  })

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

  it('re-lists for page one, and for another connection or none', async () => {
    const cache = new DirListingPageCache(() => 0)
    const list = vi.fn(async () => folder(5))
    const after = cursorOf(folder(5)[1])
    await cache.readPage('socket-1', { ...REQUEST, limit: 2 }, list)

    await cache.readPage('socket-1', { ...REQUEST, limit: 2 }, list)
    await cache.readPage('socket-2', { ...REQUEST, after, limit: 2 }, list)
    await cache.readPage(undefined, { ...REQUEST, after, limit: 2 }, list)
    expect(list).toHaveBeenCalledTimes(4)
  })

  it('keys the listing by folder and symlink mode', async () => {
    const cache = new DirListingPageCache(() => 0)
    const list = vi.fn(async () => folder(5))
    const after = cursorOf(folder(5)[1])
    await cache.readPage('socket-1', { ...REQUEST, limit: 2 }, list)

    await cache.readPage('socket-1', { ...REQUEST, relativePath: 'other', after }, list)
    await cache.readPage('socket-1', { ...REQUEST, followSymlinks: true, after }, list)
    expect(list).toHaveBeenCalledTimes(3)
  })

  it('holds a bounded number of listings, dropping the oldest', async () => {
    const cache = new DirListingPageCache(() => 0)
    const list = vi.fn(async () => folder(3))
    const after = cursorOf(folder(3)[0])
    for (let index = 0; index < 9; index++) {
      await cache.readPage('socket-1', { ...REQUEST, relativePath: `d${index}`, limit: 1 }, list)
    }
    expect(list).toHaveBeenCalledTimes(9)

    await cache.readPage('socket-1', { ...REQUEST, relativePath: 'd8', after, limit: 1 }, list)
    expect(list).toHaveBeenCalledTimes(9)
    await cache.readPage('socket-1', { ...REQUEST, relativePath: 'd0', after, limit: 1 }, list)
    expect(list).toHaveBeenCalledTimes(10)
  })

  it('holds an oversized folder alone, so scrolling it costs one listing', async () => {
    const cache = new DirListingPageCache(() => 0)
    const small = vi.fn(async () => folder(3))
    await cache.readPage('socket-1', { ...REQUEST, relativePath: 'small', limit: 1 }, small)
    const big = folder(200_001)
    const list = vi.fn(async () => big)
    await cache.readPage('socket-1', { ...REQUEST, limit: 5_000 }, list)
    await cache.readPage(
      'socket-1',
      { ...REQUEST, after: cursorOf(big[4_999]), limit: 5_000 },
      list
    )
    await cache.readPage(
      'socket-1',
      { ...REQUEST, after: cursorOf(big[9_999]), limit: 5_000 },
      list
    )
    expect(list).toHaveBeenCalledTimes(1)
    expect(cache.heldEntryCount).toBe(200_001)

    await cache.readPage(
      'socket-1',
      { ...REQUEST, relativePath: 'small', after: cursorOf(folder(3)[0]), limit: 1 },
      small
    )
    expect(small).toHaveBeenCalledTimes(2)
  })

  it('never holds a folder over a million entries; its pages list again', async () => {
    const cache = new DirListingPageCache(() => 0)
    const huge = folder(1_000_001)
    const list = vi.fn(async () => huge)
    await cache.readPage('socket-1', { ...REQUEST, limit: 5_000 }, list)
    expect(cache.heldEntryCount).toBe(0)
    await cache.readPage(
      'socket-1',
      { ...REQUEST, after: cursorOf(huge[4_999]), limit: 5_000 },
      list
    )
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('releases a listing once its time is up, with no further reads', async () => {
    vi.useFakeTimers()
    try {
      const cache = new DirListingPageCache(() => Date.now())
      await cache.readPage('socket-1', { ...REQUEST, limit: 2 }, async () => folder(5))
      expect(cache.heldEntryCount).toBe(5)
      await vi.advanceTimersByTimeAsync(DIR_LISTING_PAGE_CACHE_TTL_MS - 1)
      expect(cache.heldEntryCount).toBe(5)
      await vi.advanceTimersByTimeAsync(1)
      expect(cache.heldEntryCount).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('matches a workspace however its id selector is spelled', async () => {
    const cache = new DirListingPageCache(() => 0)
    await cache.readPage('socket-1', { ...REQUEST, limit: 2 }, async () => folder(5))
    cache.forgetWorkspace('wt-1')
    expect(cache.heldEntryCount).toBe(0)
  })

  it('shares one in-flight listing between concurrent reads of a folder', async () => {
    const cache = new DirListingPageCache(() => 0)
    let finish!: (entries: DirEntry[]) => void
    const list = vi.fn(
      () =>
        new Promise<DirEntry[]>((resolve) => {
          finish = resolve
        })
    )
    const pages = [
      cache.readPage('socket-1', { ...REQUEST, limit: 2 }, list),
      cache.readPage('socket-1', { ...REQUEST, limit: 2 }, list)
    ]
    finish(folder(5))
    expect((await Promise.all(pages)).map((page) => names(page.entries))).toEqual([
      names(folder(2)),
      names(folder(2))
    ])
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('releases an expired listing on the next read of any folder', async () => {
    let now = 0
    const cache = new DirListingPageCache(() => now)
    await cache.readPage('socket-1', { ...REQUEST, limit: 2 }, async () => folder(150_000))
    expect(cache.heldEntryCount).toBe(150_000)

    now = DIR_LISTING_PAGE_CACHE_TTL_MS
    await cache.readPage('socket-1', { ...REQUEST, relativePath: 'tiny' }, async () => folder(1))
    expect(cache.heldEntryCount).toBe(0)
  })
})

function dispatcherWithListing(entries: DirEntry[]) {
  const readFileExplorerDir = vi
    .fn<OrcaRuntimeService['readFileExplorerDir']>()
    .mockResolvedValue(entries)
  const runtime: Pick<OrcaRuntimeService, 'getRuntimeId' | 'readFileExplorerDir'> = {
    getRuntimeId: () => 'test-runtime',
    readFileExplorerDir
  }
  const dispatcher = new RpcDispatcher({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: files.readDir uses readFileExplorerDir; its response envelope reads only getRuntimeId.
    runtime: runtime as OrcaRuntimeService,
    methods: FILE_METHODS
  })
  return { dispatcher, readFileExplorerDir }
}

async function readDir(
  dispatcher: RpcDispatcher,
  params: Record<string, unknown>,
  connectionId = 'socket-1'
) {
  const replies: unknown[] = []
  await dispatcher.dispatchStreaming(
    { id: 'read', authToken: 'tok', method: 'files.readDir', params },
    (reply) => replies.push(JSON.parse(reply)),
    { clientKind: 'runtime', connectionId }
  )
  return replies[0]
}

describe('files.readDir pages', () => {
  it('pages a folder too large for one remote reply', async () => {
    const { dispatcher, readFileExplorerDir } = dispatcherWithListing(folder(80_000, 'paged'))

    const first = await readDir(dispatcher, { ...REQUEST, limit: 1_000 })
    const next = await readDir(dispatcher, {
      ...REQUEST,
      after: cursorOf(folder(80_000, 'paged')[999]),
      limit: 1_000
    })

    expect(first).toMatchObject({ ok: true, result: { total: 80_000, hasMore: true } })
    expect(next).toMatchObject({
      ok: true,
      result: {
        total: 80_000,
        hasMore: true,
        entries: expect.arrayContaining([folder(80_000, 'paged')[1_000]])
      }
    })
    expect(readFileExplorerDir).toHaveBeenCalledTimes(1)
  })

  it('keeps the bare entry array when no page is asked for', async () => {
    const { dispatcher } = dispatcherWithListing(folder(3))
    expect(await readDir(dispatcher, REQUEST)).toMatchObject({
      ok: true,
      result: folder(3)
    })
  })

  it('refuses a page larger than a host serves, and a cursor without its kind or too long', async () => {
    const { dispatcher } = dispatcherWithListing(folder(3))
    expect(await readDir(dispatcher, { ...REQUEST, limit: 5_001 })).toMatchObject({ ok: false })
    expect(await readDir(dispatcher, { ...REQUEST, after: { name: 'a' } })).toMatchObject({
      ok: false
    })
    expect(
      await readDir(dispatcher, {
        ...REQUEST,
        after: { name: 'a'.repeat(4097), isDirectory: false }
      })
    ).toMatchObject({ ok: false })
  })

  it("drops a cached listing when the host's watcher reports a change in that workspace", async () => {
    let entries = folder(6)
    let emitChange: ((events: { kind: 'delete'; absolutePath: string }[]) => void) | undefined
    const readFileExplorerDir = vi.fn(async () => entries)
    const fakeRuntime = {
      getRuntimeId: () => 'test-runtime',
      readFileExplorerDir,
      watchFileExplorer: vi.fn(async (_worktree: string, callback: typeof emitChange) => {
        emitChange = callback
        return vi.fn()
      }),
      registerSubscriptionCleanup: vi.fn()
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: files.readDir and files.watch only touch these runtime members.
    const runtime = fakeRuntime as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: FILE_METHODS })
    void dispatcher.dispatchStreaming(
      { id: 'watch', authToken: 'tok', method: 'files.watch', params: { worktree: 'id:wt-1' } },
      () => {},
      { connectionId: 'socket-2' }
    )
    await vi.waitFor(() => expect(emitChange).toBeDefined())

    await readDir(dispatcher, { ...REQUEST, limit: 2 })
    entries = entries.filter((entry) => entry.name !== 'file-000004.txt')
    emitChange?.([{ kind: 'delete', absolutePath: '/repo/big/file-000004.txt' }])
    const next = await readDir(dispatcher, { ...REQUEST, after: cursorOf(folder(6)[1]), limit: 5 })

    expect(readFileExplorerDir).toHaveBeenCalledTimes(2)
    expect(next).toMatchObject({ ok: true, result: { total: 5, hasMore: false } })
  })
})
