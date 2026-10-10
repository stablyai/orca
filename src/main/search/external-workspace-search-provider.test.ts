import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type * as GitRunner from '../git/runner'
import {
  setExternalWorkspaceSearchProvider,
  type ExternalWorkspaceSearchProvider
} from './external-workspace-search-provider'

const { wslAwareSpawnMock } = vi.hoisted(() => ({ wslAwareSpawnMock: vi.fn() }))

vi.mock('../git/runner', async (importOriginal) => {
  const original = await importOriginal<typeof GitRunner>()
  return {
    ...original,
    wslAwareSpawn: (...args: Parameters<typeof original.wslAwareSpawn>) =>
      wslAwareSpawnMock.getMockImplementation()
        ? wslAwareSpawnMock(...args)
        : original.wslAwareSpawn(...args)
  }
})

import { listQuickOpenFiles } from '../ipc/filesystem-list-files'
import { searchQuickOpenFilePaths } from '../ipc/filesystem-search-file-paths'
import { runBundledRipgrepTextSearch } from '../ripgrep/bundled-ripgrep-text-search'

function makeStore(repoPath: string): Store {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: listing only reads registered repos and settings.
  return {
    getRepos: () => [
      { id: 'repo-1', path: repoPath, displayName: 'repo', badgeColor: '#000', addedAt: 0 }
    ],
    getSettings: () => ({})
  } as unknown as Store
}

function fakeRipgrep(output: string): EventEmitter {
  const child = new EventEmitter()
  const stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() })
  Object.assign(child, {
    stdout,
    stderr: new EventEmitter(),
    kill: vi.fn(),
    exitCode: null,
    signalCode: null,
    pid: 1
  })
  setTimeout(() => {
    stdout.emit('data', output)
    child.emit('close', 0, null)
  }, 0)
  return child
}

function provider(
  answers: Partial<ExternalWorkspaceSearchProvider>
): ExternalWorkspaceSearchProvider {
  return {
    listFiles: async () => null,
    searchFilePaths: async () => null,
    searchText: async () => null,
    supportsRankedPathSearch: async () => false,
    ...answers
  }
}

afterEach(() => {
  setExternalWorkspaceSearchProvider(null)
  wslAwareSpawnMock.mockReset()
})

describe('external workspace search provider hooks', () => {
  it('lets an index answer the quick-open listing without spawning ripgrep', async () => {
    const listFiles = vi.fn(async () => ['indexed.ts'])
    setExternalWorkspaceSearchProvider(provider({ listFiles }))
    expect(await listQuickOpenFiles('/repo', makeStore('/repo'), undefined, undefined, 10)).toEqual(
      ['indexed.ts']
    )
    expect(wslAwareSpawnMock).not.toHaveBeenCalled()
    expect(listFiles).toHaveBeenCalledWith(
      expect.objectContaining({ includeIgnored: true, followSymlinks: false, maxResults: 10 })
    )
  })

  it('walks with ripgrep when the index declines the listing', async () => {
    setExternalWorkspaceSearchProvider(provider({}))
    wslAwareSpawnMock
      .mockImplementationOnce(() => fakeRipgrep('walked.ts\0'))
      .mockImplementationOnce(() => fakeRipgrep(''))
    expect(await listQuickOpenFiles('/repo', makeStore('/repo'), undefined, undefined, 10)).toEqual(
      ['walked.ts']
    )
    expect(wslAwareSpawnMock).toHaveBeenCalled()
  })

  it('lets an index rank quick-open paths, and falls back to the ripgrep ranker', async () => {
    setExternalWorkspaceSearchProvider(
      provider({
        searchFilePaths: async () => ({ paths: ['src/Hit.ts'], totalCount: 1, truncated: false })
      })
    )
    expect(
      await searchQuickOpenFilePaths('/repo', makeStore('/repo'), { query: 'hit', limit: 5 })
    ).toEqual({ paths: ['src/Hit.ts'], totalCount: 1, truncated: false })
    expect(wslAwareSpawnMock).not.toHaveBeenCalled()

    setExternalWorkspaceSearchProvider(provider({}))
    wslAwareSpawnMock.mockImplementationOnce(() => fakeRipgrep('src/Hit.ts\0src/other.ts\0'))
    const fallback = await searchQuickOpenFilePaths('/repo', makeStore('/repo'), {
      query: 'hit',
      limit: 5
    })
    expect(fallback.paths).toEqual(['src/Hit.ts'])
  })

  it('lets an index answer text search, and runs the bundled ripgrep when it declines', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'orca-external-search-'))
    const onSpawn = vi.fn(() => () => undefined)
    try {
      await writeFile(join(rootPath, 'a.txt'), 'needle\n')
      const indexed = { files: [], totalMatches: 0, truncated: false }
      setExternalWorkspaceSearchProvider(provider({ searchText: async () => indexed }))
      const options = { rootPath, query: 'needle' }
      expect(
        await runBundledRipgrepTextSearch({ options, rootPath, resultRootPath: rootPath, onSpawn })
      ).toBe(indexed)
      expect(onSpawn).not.toHaveBeenCalled()

      setExternalWorkspaceSearchProvider(provider({}))
      const walked = await runBundledRipgrepTextSearch({
        options,
        rootPath,
        resultRootPath: rootPath,
        onSpawn
      })
      expect(walked.totalMatches).toBe(1)
      expect(onSpawn).toHaveBeenCalledOnce()
    } finally {
      await rm(rootPath, { recursive: true, force: true })
    }
  })

  it('never offers WSL-routed text search to the index', async () => {
    const searchText = vi.fn(async () => ({ files: [], totalMatches: 0, truncated: false }))
    setExternalWorkspaceSearchProvider(provider({ searchText }))
    wslAwareSpawnMock.mockImplementationOnce(() => fakeRipgrep(''))
    const result = await runBundledRipgrepTextSearch({
      options: { rootPath: '/repo', query: 'x' },
      rootPath: '/repo',
      resultRootPath: '/repo',
      wslDistro: 'Ubuntu',
      onSpawn: () => () => undefined
    })
    expect(result.totalMatches).toBe(0)
    expect(wslAwareSpawnMock).toHaveBeenCalledOnce()
    expect(searchText).not.toHaveBeenCalled()
  })
})
