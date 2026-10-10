import type { ProcessResult } from '@orca/process-host/process-spec'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RunProcessModule from '@orca/process-host'
import type * as FsHandlerGitFallback from './fs-handler-git-fallback'
import type * as FsHandlerUtils from './fs-handler-utils'

const {
  runProcessMock,
  listFilesWithGitMock,
  listFilesWithReaddirMock,
  listFilesWithRgMock,
  searchWithGitGrepMock,
  searchWithRgMock
} = vi.hoisted(() => ({
  runProcessMock: vi.fn<typeof RunProcessModule.runProcess>(),
  listFilesWithGitMock: vi.fn(),
  listFilesWithReaddirMock: vi.fn(),
  listFilesWithRgMock: vi.fn(),
  searchWithGitGrepMock: vi.fn(),
  searchWithRgMock: vi.fn()
}))

vi.mock('@orca/process-host', async (importOriginal) => ({
  ...(await importOriginal<typeof RunProcessModule>()),
  runProcess: runProcessMock
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

vi.mock('./fs-handler-readdir-fallback', () => ({
  listFilesWithReaddir: listFilesWithReaddirMock
}))

import { FileListingCancelledError } from '../shared/file-listing-cancellation'
import { RipgrepUnavailableError } from '../shared/ripgrep-process-availability'
import { RelayContext } from './context'
import { FsHandler } from './fs-handler'
import { runListFilesScan } from './fs-list-files-fallback-chain'
import { buildRelayCommandEnv } from './relay-command-env'

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

  it.each(['true\n', 'false\n'])(
    'uses the Git listing after a successful probe (%s)',
    async (stdout) => {
      const controller = new AbortController()
      listFilesWithRgMock.mockRejectedValueOnce(new RipgrepUnavailableError())
      runProcessMock.mockResolvedValueOnce({
        code: 0,
        signal: null,
        stdout,
        stderr: '',
        timedOut: false
      })
      listFilesWithGitMock.mockResolvedValueOnce(['src/index.ts'])

      await expect(runListFilesScan('/repo', [], controller.signal)).resolves.toEqual([
        'src/index.ts'
      ])
      expect(listFilesWithRgMock).toHaveBeenCalledTimes(1)
      expect(runProcessMock).toHaveBeenCalledWith({
        program: 'git',
        args: ['rev-parse', '--is-inside-work-tree'],
        cwd: '/repo',
        env: buildRelayCommandEnv(),
        timeoutMs: 5_000,
        signal: controller.signal
      })
      expect(listFilesWithGitMock).toHaveBeenCalledTimes(1)
      expect(listFilesWithReaddirMock).not.toHaveBeenCalled()
    }
  )

  it.each([
    { code: 128, signal: null, timedOut: false },
    { code: null, signal: 'SIGTERM', timedOut: false },
    { code: 0, signal: null, timedOut: true }
  ] as const)('uses the directory walk when the Git probe fails (%j)', async (result) => {
    const controller = new AbortController()
    listFilesWithRgMock.mockRejectedValueOnce(new RipgrepUnavailableError())
    runProcessMock.mockResolvedValueOnce({ ...result, stdout: '', stderr: '' })
    listFilesWithReaddirMock.mockResolvedValueOnce(['src/index.ts'])

    await expect(runListFilesScan('/folder', [], controller.signal)).resolves.toEqual([
      'src/index.ts'
    ])
    expect(listFilesWithGitMock).not.toHaveBeenCalled()
    expect(listFilesWithReaddirMock).toHaveBeenCalledWith('/folder', [], {
      signal: controller.signal,
      maxResults: undefined
    })
  })

  it('uses the directory walk when Git cannot start', async () => {
    const controller = new AbortController()
    listFilesWithRgMock.mockRejectedValueOnce(new RipgrepUnavailableError())
    runProcessMock.mockRejectedValueOnce(new Error('spawn git ENOENT'))
    listFilesWithReaddirMock.mockResolvedValueOnce(['src/index.ts'])

    await expect(runListFilesScan('/folder', [], controller.signal)).resolves.toEqual([
      'src/index.ts'
    ])
    expect(listFilesWithGitMock).not.toHaveBeenCalled()
    expect(listFilesWithReaddirMock).toHaveBeenCalledTimes(1)
  })

  it.each([0, 128])('lets cancellation during the Git probe win its exit (%s)', async (code) => {
    const controller = new AbortController()
    const cancellation = new FileListingCancelledError('superseded')
    const probe = Promise.withResolvers<ProcessResult>()
    listFilesWithRgMock.mockRejectedValueOnce(new RipgrepUnavailableError())
    runProcessMock.mockReturnValueOnce(probe.promise)

    const scan = runListFilesScan('/repo', [], controller.signal)
    await vi.waitFor(() => expect(runProcessMock).toHaveBeenCalledTimes(1))
    expect(runProcessMock.mock.calls[0][0].signal).toBe(controller.signal)
    controller.abort(cancellation)
    probe.resolve({ code, signal: null, stdout: '', stderr: '', timedOut: false })

    await expect(scan).rejects.toBe(cancellation)
    expect(listFilesWithGitMock).not.toHaveBeenCalled()
    expect(listFilesWithReaddirMock).not.toHaveBeenCalled()
  })

  it('lets cancellation win an unavailable-listing race before Git starts', async () => {
    const controller = new AbortController()
    const cancellation = new FileListingCancelledError('superseded')
    listFilesWithRgMock.mockImplementationOnce(async () => {
      controller.abort(cancellation)
      throw new RipgrepUnavailableError()
    })

    await expect(runListFilesScan('/repo', [], controller.signal)).rejects.toBe(cancellation)
    expect(runProcessMock).not.toHaveBeenCalled()
    expect(listFilesWithGitMock).not.toHaveBeenCalled()
    expect(listFilesWithReaddirMock).not.toHaveBeenCalled()
  })

  it('requires ripgrep for bounded query ranking instead of retaining a full Git inventory', async () => {
    const controller = new AbortController()
    listFilesWithRgMock.mockRejectedValueOnce(new RipgrepUnavailableError())

    await expect(runListFilesScan('/repo', [], controller.signal, 33, 'target')).rejects.toThrow(
      'Quick Open search requires ripgrep'
    )
    expect(runProcessMock).not.toHaveBeenCalled()
    expect(listFilesWithGitMock).not.toHaveBeenCalled()
  })
})
