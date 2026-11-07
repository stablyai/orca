import '../../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../../dispatcher'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { DirEntry } from '../../../../../shared/filesystem-entry-types'
import type { DirEntryCursor } from '../../../../../shared/file-dir-page'
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
