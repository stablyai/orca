import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ChildProcessModule from 'node:child_process'
import type * as FsHandlerGitFallback from './fs-handler-git-fallback'
import type * as FsHandlerUtils from './fs-handler-utils'

const {
  execFileMock,
  listFilesWithGitMock,
  listFilesWithRgMock,
  searchWithGitGrepMock,
  searchWithRgMock
} = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  listFilesWithGitMock: vi.fn(),
  listFilesWithRgMock: vi.fn(),
  searchWithGitGrepMock: vi.fn(),
  searchWithRgMock: vi.fn()
}))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcessModule>()),
  execFile: execFileMock
}))

vi.mock('./fs-handler-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof FsHandlerUtils>()),
  listFilesWithRg: listFilesWithRgMock,
  searchWithRg: searchWithRgMock
}))

vi.mock('./fs-handler-git-fallback', async (importOriginal) => ({
  ...(await importOriginal<typeof FsHandlerGitFallback>()),
  listFilesWithGit: listFilesWithGitMock,
  searchWithGitGrep: searchWithGitGrepMock
}))

import { FileListingCancelledError } from '../shared/file-listing-cancellation'
import { RipgrepUnavailableError } from '../shared/ripgrep-process-availability'
import { RelayContext } from './context'
import { FsHandler } from './fs-handler'
import { runListFilesScan } from './fs-list-files-fallback-chain'

type FsHandlerInternals = {
  search(params: Record<string, unknown>): Promise<unknown>
}

function createHandler(): FsHandlerInternals {
  const dispatcher = {
    onRequest: vi.fn(),
    onNotification: vi.fn(),
    onClientDetached: vi.fn(() => () => undefined)
  }
  const watcherPool = {
    dispose: vi.fn(),
    forgetRoot: vi.fn(),
    subscribe: vi.fn()
  }
  return new FsHandler(dispatcher as never, new RelayContext(), watcherPool as never) as never
}

describe('relay direct ripgrep admission', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('falls back only for a tagged search launch failure', async () => {
    const handler = createHandler()
    const fallback = { files: [], totalMatches: 0, truncated: false }
    searchWithRgMock.mockRejectedValueOnce(new RipgrepUnavailableError())
    searchWithGitGrepMock.mockResolvedValueOnce(fallback)

    await expect(handler.search({ rootPath: '/repo', query: 'needle' })).resolves.toBe(fallback)
    expect(searchWithRgMock).toHaveBeenCalledTimes(1)
    expect(searchWithGitGrepMock).toHaveBeenCalledTimes(1)

    const ordinaryFailure = new Error('rg failed after spawn')
    searchWithRgMock.mockRejectedValueOnce(ordinaryFailure)
    await expect(handler.search({ rootPath: '/repo', query: 'needle' })).rejects.toBe(
      ordinaryFailure
    )
    expect(searchWithGitGrepMock).toHaveBeenCalledTimes(1)
  })

  it('falls back only for a tagged listing launch failure', async () => {
    const controller = new AbortController()
    listFilesWithRgMock.mockRejectedValueOnce(new RipgrepUnavailableError())
    execFileMock.mockImplementationOnce((_command, _args, _options, callback) => {
      callback(null)
      return undefined
    })
    listFilesWithGitMock.mockResolvedValueOnce(['src/index.ts'])

    await expect(runListFilesScan('/repo', [], controller.signal)).resolves.toEqual([
      'src/index.ts'
    ])
    expect(listFilesWithRgMock).toHaveBeenCalledTimes(1)
    expect(listFilesWithGitMock).toHaveBeenCalledTimes(1)
  })

  it('lets cancellation win an unavailable-listing race before Git starts', async () => {
    const controller = new AbortController()
    const cancellation = new FileListingCancelledError('superseded')
    listFilesWithRgMock.mockImplementationOnce(async () => {
      controller.abort(cancellation)
      throw new RipgrepUnavailableError()
    })

    await expect(runListFilesScan('/repo', [], controller.signal)).rejects.toBe(cancellation)
    expect(execFileMock).not.toHaveBeenCalled()
    expect(listFilesWithGitMock).not.toHaveBeenCalled()
  })

  it('requires ripgrep for bounded query ranking instead of retaining a full Git inventory', async () => {
    const controller = new AbortController()
    listFilesWithRgMock.mockRejectedValueOnce(new RipgrepUnavailableError())

    await expect(runListFilesScan('/repo', [], controller.signal, 33, 'target')).rejects.toThrow(
      'Quick Open search requires ripgrep'
    )
    expect(execFileMock).not.toHaveBeenCalled()
    expect(listFilesWithGitMock).not.toHaveBeenCalled()
  })
})
