import { describe, expect, it, vi } from 'vitest'
import { getSshFilesystemProviderMock } from './orca-runtime-files-mock-registry'
import {
  createRuntimeFileCommands,
  useRuntimeFileCommandsLifecycle
} from './orca-runtime-files-test-harness'

vi.mock('fs', async () => (await import('./orca-runtime-files-mock-registry')).fsModuleMock())
vi.mock('fs/promises', async () =>
  (await import('./orca-runtime-files-mock-registry')).fsPromisesModuleMock()
)
vi.mock(
  './file-watcher-host',
  async () => (await import('./orca-runtime-files-mock-registry')).fileWatcherHostMock
)
vi.mock('../ipc/filesystem-auth', async () =>
  (await import('./orca-runtime-files-mock-registry')).filesystemAuthModuleMock()
)
vi.mock('../git/runner', async () =>
  (await import('./orca-runtime-files-mock-registry')).gitRunnerModuleMock()
)
vi.mock(
  '../ipc/local-worktree-runtime-options',
  async () => (await import('./orca-runtime-files-mock-registry')).localWorktreeRuntimeOptionsMock
)
vi.mock('../ripgrep/bundled-ripgrep-path', async () =>
  (await import('./orca-runtime-files-mock-registry')).bundledRipgrepPathModuleMock()
)
vi.mock(
  '../providers/ssh-filesystem-dispatch',
  async () => (await import('./orca-runtime-files-mock-registry')).sshFilesystemDispatchMock
)

function remoteSearch(version: number | null) {
  const latePath = 'late/target.ts'
  const legacy = Array.from({ length: 32 }, (_, i) => `early/unrelated${i}.ts`)
  const listFiles = vi.fn(async (_root: string, options?: { searchQuery?: string }) =>
    options?.searchQuery ? [latePath] : legacy
  )
  const supportsQuickOpenSearch = vi.fn(
    async (options?: { minimumVersion?: number; signal?: AbortSignal }) => {
      options?.signal?.throwIfAborted()
      return version !== null && version >= (options?.minimumVersion ?? 3)
    }
  )
  getSshFilesystemProviderMock.mockReturnValue({
    listFiles,
    ...(version === null ? {} : { supportsQuickOpenSearch })
  })
  return {
    ...createRuntimeFileCommands({ hostId: 'ssh:ssh-1' }),
    listFiles,
    supportsQuickOpenSearch
  }
}

describe('runtime SSH Quick Open capability requirements', () => {
  useRuntimeFileCommandsLifecycle()

  it.each([1, 2, 3, 4])(
    'uses host search for a simple late match on version %i',
    async (version) => {
      const { commands, listFiles, supportsQuickOpenSearch } = remoteSearch(version)
      const controller = new AbortController()
      await expect(
        commands.searchQuickOpenFilePaths('id:wt-1', 'target', 7, ['nested'], controller.signal)
      ).resolves.toMatchObject({ files: [{ relativePath: 'late/target.ts' }], truncated: false })
      expect(supportsQuickOpenSearch).toHaveBeenCalledWith({
        signal: controller.signal,
        minimumVersion: 1
      })
      expect(listFiles).toHaveBeenCalledWith('/repo', {
        excludePaths: ['nested'],
        maxResults: 8,
        searchQuery: 'target',
        signal: controller.signal
      })
    }
  )

  it.each([0, null])(
    'keeps the bounded compatibility prefix only without v1 (%s)',
    async (version) => {
      const { commands, listFiles } = remoteSearch(version)
      await expect(
        commands.searchQuickOpenFilePaths('id:wt-1', 'target', 7)
      ).resolves.toMatchObject({
        files: [],
        truncated: true
      })
      expect(listFiles).toHaveBeenCalledWith('/repo', {
        excludePaths: undefined,
        maxResults: 32,
        signal: undefined
      })
    }
  )

  it.each(['package-lock', 'my_file', 'file name'])(
    'preserves existing filename search %s on older relays',
    async (query) => {
      for (const version of [1, 2, 3]) {
        const { commands, listFiles } = remoteSearch(version)
        await expect(commands.searchQuickOpenFilePaths('id:wt-1', query, 7)).resolves.toMatchObject(
          {
            files: [{ relativePath: 'late/target.ts' }]
          }
        )
        expect(listFiles).toHaveBeenCalledWith(
          '/repo',
          expect.objectContaining({ searchQuery: query, maxResults: 8 })
        )
      }
    }
  )

  it('does not require v3 for whitespace only around a simple query', async () => {
    const { commands, supportsQuickOpenSearch } = remoteSearch(1)
    await commands.searchQuickOpenFilePaths('id:wt-1', ' target ', 7)
    expect(supportsQuickOpenSearch).toHaveBeenCalledWith({ signal: undefined, minimumVersion: 1 })
  })

  it.each([{ includeIgnored: false }, { followSymlinks: true }])(
    'requires v2 for discovery %j',
    async (options) => {
      for (const version of [null, 0, 1]) {
        const { commands, listFiles } = remoteSearch(version)
        await expect(
          commands.searchQuickOpenFilePaths('id:wt-1', 'target', 7, undefined, undefined, options)
        ).rejects.toThrow('listing options')
        expect(listFiles).not.toHaveBeenCalled()
      }
      const { commands, listFiles } = remoteSearch(2)
      await commands.searchQuickOpenFilePaths('id:wt-1', 'target', 7, undefined, undefined, options)
      expect(listFiles).toHaveBeenCalledWith(
        '/repo',
        expect.objectContaining({ ...options, searchQuery: 'target', maxResults: 8 })
      )
    }
  )

  it('forwards abort to the capability probe and starts no listing after rejection', async () => {
    const { commands, listFiles } = remoteSearch(1)
    const controller = new AbortController()
    controller.abort(new Error('abandoned'))
    await expect(
      commands.searchQuickOpenFilePaths('id:wt-1', 'target', 7, undefined, controller.signal)
    ).rejects.toThrow('abandoned')
    expect(listFiles).not.toHaveBeenCalled()
  })
})

describe('runtime SSH file-list capability requirements', () => {
  useRuntimeFileCommandsLifecycle()

  it.each([{ includeIgnored: false }, { followSymlinks: true }])(
    'requires discovery v2 for %j',
    async (options) => {
      for (const version of [null, 0, 1]) {
        const { commands, listFiles } = remoteSearch(version)
        await expect(commands.listRuntimeFiles('id:wt-1', options)).rejects.toThrow(
          'listing options'
        )
        expect(listFiles).not.toHaveBeenCalled()
      }
      for (const version of [2, 3, 4]) {
        const { commands, listFiles, supportsQuickOpenSearch } = remoteSearch(version)
        const controller = new AbortController()
        await commands.listRuntimeFiles('id:wt-1', {
          ...options,
          signal: controller.signal,
          maxResults: 9
        })
        expect(supportsQuickOpenSearch).toHaveBeenCalledWith({
          minimumVersion: 2,
          signal: controller.signal
        })
        expect(listFiles).toHaveBeenCalledWith(
          '/repo',
          expect.objectContaining({ ...options, signal: controller.signal, maxResults: 9 })
        )
      }
    }
  )

  it('requires v3 for candidate validation even with default discovery settings', async () => {
    for (const version of [null, 0, 1, 2]) {
      const { commands, listFiles } = remoteSearch(version)
      await expect(
        commands.listRuntimeFiles('id:wt-1', { candidatePaths: ['recent.ts'] })
      ).rejects.toThrow('validate Quick Open recent files')
      expect(listFiles).not.toHaveBeenCalled()
    }
    const { commands, supportsQuickOpenSearch, listFiles } = remoteSearch(3)
    await commands.listRuntimeFiles('id:wt-1', {
      candidatePaths: ['recent.ts'],
      includeIgnored: false
    })
    expect(supportsQuickOpenSearch).toHaveBeenCalledWith({ minimumVersion: 3, signal: undefined })
    expect(listFiles).toHaveBeenCalledWith(
      '/repo',
      expect.objectContaining({ candidatePaths: ['recent.ts'], includeIgnored: false })
    )
  })

  it('keeps default legacy listings and disconnected results unchanged', async () => {
    const { commands, supportsQuickOpenSearch, listFiles } = remoteSearch(0)
    await commands.listRuntimeFiles('id:wt-1', { includeIgnored: true, followSymlinks: false })
    expect(listFiles).toHaveBeenCalledOnce()
    expect(supportsQuickOpenSearch).not.toHaveBeenCalled()
    getSshFilesystemProviderMock.mockReturnValue(null)
    await expect(commands.listRuntimeFiles('id:wt-1', { followSymlinks: true })).resolves.toEqual(
      []
    )
  })
})

it.each([0, 1, 2, 3, 4])(
  'reports execution relay matching capability %i through a paired runtime',
  async (version) => {
    const { commands } = remoteSearch(version)
    const result = await commands.searchQuickOpenFilePaths('id:wt-1', '', 7)
    expect(result.quickOpenSearchVersion).toBe(Math.min(version, 3))
  }
)

it('keeps inherited ignored-file visibility from breaking searches on an older relay', async () => {
  const { commands, listFiles } = remoteSearch(1)
  await expect(
    commands.searchQuickOpenFilePaths('id:wt-1', 'target', 7, undefined, undefined, {
      includeIgnored: false,
      allowLegacyIncludeIgnored: true
    })
  ).resolves.toMatchObject({ files: [{ relativePath: 'late/target.ts' }] })
  expect(listFiles).toHaveBeenCalledWith(
    '/repo',
    expect.not.objectContaining({ includeIgnored: false })
  )
})
