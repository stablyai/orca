import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../../persistence'
import {
  setExternalWorkspaceSearchProvider,
  type ExternalWorkspaceSearchProvider
} from '../../search/external-workspace-search-provider'

const { handlers, resolveRootMock } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => unknown>(),
  resolveRootMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => unknown) =>
      handlers.set(channel, handler)
  }
}))
vi.mock('../quick-open-search-root', () => ({ resolveQuickOpenSearchRoot: resolveRootMock }))

import { registerFilesystemExternalSearchHandlers } from './filesystem-external-search-handlers'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler only forwards the store to the mocked root resolver.
registerFilesystemExternalSearchHandlers({ store: {} as Store })

function rankedPathSearch(args: unknown): unknown {
  return handlers.get('fs:rankedPathSearch')?.(null, args)
}

function mockProvider(
  supportsRankedPathSearch: ExternalWorkspaceSearchProvider['supportsRankedPathSearch']
) {
  setExternalWorkspaceSearchProvider({
    listFiles: async () => null,
    searchFilePaths: async () => null,
    searchText: async () => null,
    supportsRankedPathSearch
  })
}

afterEach(() => {
  setExternalWorkspaceSearchProvider(null)
  resolveRootMock.mockReset()
})

describe('fs:rankedPathSearch', () => {
  it('answers false without a provider, so quick open keeps listing in the renderer', async () => {
    expect(await rankedPathSearch({ rootPath: '/repo' })).toBe(false)
    expect(resolveRootMock).not.toHaveBeenCalled()
  })

  it('asks the provider about the authorized local root with resolved defaults', async () => {
    const supports = vi.fn(async () => true)
    mockProvider(supports)
    resolveRootMock.mockResolvedValue({
      authorizedRootPath: '/private/repo',
      excludePathPrefixes: [],
      wslDistroForOutput: undefined
    })
    expect(await rankedPathSearch({ rootPath: '/repo' })).toBe(true)
    expect(supports).toHaveBeenCalledWith({
      rootPath: '/private/repo',
      includeIgnored: true,
      followSymlinks: false
    })
  })

  it('keeps WSL roots and unauthorized roots on the renderer path', async () => {
    const supports = vi.fn(async () => true)
    mockProvider(supports)
    resolveRootMock.mockResolvedValueOnce({
      authorizedRootPath: '\\\\wsl.localhost\\Ubuntu\\repo',
      excludePathPrefixes: [],
      wslDistroForOutput: 'Ubuntu'
    })
    expect(await rankedPathSearch({ rootPath: '\\\\wsl.localhost\\Ubuntu\\repo' })).toBe(false)
    resolveRootMock.mockRejectedValueOnce(new Error('Access denied'))
    expect(await rankedPathSearch({ rootPath: '/elsewhere' })).toBe(false)
    expect(supports).not.toHaveBeenCalled()
  })
})
