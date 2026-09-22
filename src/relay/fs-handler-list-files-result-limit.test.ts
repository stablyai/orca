/**
 * #12547: the relay used to serialize an unbounded `fs.listFiles` reply into one response frame,
 * which died as "Message too large" or over-capacity. #17954 fixed that by streaming the reply, so
 * the size of a listing is no longer a correctness question and the host must NOT quietly impose a
 * cap of its own — a caller that named no limit reads the array as the whole listing, and clients
 * that predate `maxResults` on this call hardcode `truncated: false`, so a prefix would reach them
 * as a complete tree with nothing on the wire to notice. The cap belongs to the caller; the host
 * only clamps it to the ceiling the scan's retention budget assumes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runListFilesScanMock } = vi.hoisted(() => ({
  runListFilesScanMock: vi.fn()
}))

vi.mock('./fs-list-files-fallback-chain', () => ({
  runListFilesScan: runListFilesScanMock
}))

vi.mock('@parcel/watcher', () => ({ subscribe: vi.fn() }))

import { FsHandler } from './fs-handler'
import { RelayContext } from './context'
import type { RelayDispatcher } from './dispatcher'
import { QUICK_OPEN_LISTING_MAX_RESULTS } from '../shared/quick-open-listing-limits'

type ListFilesHandler = (
  params: Record<string, unknown>,
  context?: { clientId: number }
) => Promise<unknown>

function createHandler(): { listFiles: ListFilesHandler; dispose: () => void } {
  const requestHandlers = new Map<string, ListFilesHandler>()
  const dispatcher = {
    onRequest: (method: string, handler: ListFilesHandler) => requestHandlers.set(method, handler),
    onNotification: vi.fn(),
    onClientDetached: vi.fn(),
    notify: vi.fn(),
    notifyBulk: vi.fn(),
    publishProducerNotification: vi.fn(() => true),
    activeClientIds: () => [],
    producerEnvelopeBudget: () => Number.MAX_SAFE_INTEGER
  } as unknown as RelayDispatcher
  const handler = new FsHandler(dispatcher, new RelayContext(), {
    dispose: vi.fn(),
    forgetRoot: vi.fn(),
    subscribe: vi.fn()
  })
  return { listFiles: requestHandlers.get('fs.listFiles')!, dispose: () => handler.dispose() }
}

describe('fs.listFiles result limit', () => {
  let listFiles: ListFilesHandler
  let dispose: () => void

  beforeEach(() => {
    runListFilesScanMock.mockReset()
    runListFilesScanMock.mockResolvedValue([])
    const created = createHandler()
    listFiles = created.listFiles
    dispose = created.dispose
    return () => dispose()
  })

  function scanMaxResults(): unknown {
    // runListFilesScan(rootPath, excludePathPrefixes, signal, maxResults, searchQuery)
    return runListFilesScanMock.mock.calls[0][3]
  }

  it('leaves a request that omitted maxResults unbounded rather than silently prefixing it', async () => {
    await listFiles({ rootPath: '/remote/root' }, { clientId: 1 })

    expect(scanMaxResults()).toBeUndefined()
  })

  it('ignores a malformed maxResults rather than treating it as a cap', async () => {
    await listFiles({ rootPath: '/remote/root', maxResults: 'all' }, { clientId: 1 })

    expect(scanMaxResults()).toBeUndefined()
  })

  it('answers an uncapped request in full, however large the tree is', async () => {
    const files = Array.from(
      { length: QUICK_OPEN_LISTING_MAX_RESULTS + 500 },
      (_, index) => `f${index}`
    )
    runListFilesScanMock.mockResolvedValue(files)

    await expect(listFiles({ rootPath: '/remote/root' }, { clientId: 1 })).resolves.toEqual(files)
  })

  it('hands a client that named a cap the prefix it asked for', async () => {
    runListFilesScanMock.mockResolvedValue(
      Array.from({ length: QUICK_OPEN_LISTING_MAX_RESULTS }, (_, index) => `f${index}`)
    )

    const files = await listFiles(
      { rootPath: '/remote/root', maxResults: QUICK_OPEN_LISTING_MAX_RESULTS },
      { clientId: 1 }
    )

    expect(files).toHaveLength(QUICK_OPEN_LISTING_MAX_RESULTS)
  })

  it('keeps a smaller client limit and clamps a larger one', async () => {
    await listFiles({ rootPath: '/remote/root', maxResults: 33 }, { clientId: 1 })
    expect(scanMaxResults()).toBe(33)

    runListFilesScanMock.mockClear()
    await listFiles(
      { rootPath: '/remote/root', maxResults: QUICK_OPEN_LISTING_MAX_RESULTS * 10 },
      { clientId: 2 }
    )
    expect(scanMaxResults()).toBe(QUICK_OPEN_LISTING_MAX_RESULTS)
  })
})
