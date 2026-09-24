import { execFile as execFileCallback, spawn, type SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type * as GitRunner from '../git/runner'
import type * as GitFallback from './filesystem-list-files-git-fallback'
import {
  pathMatchesFileNameFilterTokens,
  splitFileNameFilterTokens
} from '../../shared/file-name-filter-tokens'

const { wslAwareSpawnMock, listFilesWithGitSpy } = vi.hoisted(() => ({
  wslAwareSpawnMock: vi.fn(),
  listFilesWithGitSpy: vi.fn()
}))

vi.mock('../git/runner', async (importOriginal) => ({
  ...(await importOriginal<typeof GitRunner>()),
  wslAwareSpawn: wslAwareSpawnMock
}))

vi.mock('./filesystem-list-files-git-fallback', async (importOriginal) => {
  const actual = await importOriginal<typeof GitFallback>()
  listFilesWithGitSpy.mockImplementation(actual.listFilesWithGit)
  return { ...actual, listFilesWithGit: listFilesWithGitSpy }
})

import { listQuickOpenFiles } from './filesystem-list-files'

const execFile = promisify(execFileCallback)

function makeStore(repoPath: string): Store {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: listing only reads registered repos and settings.
  return {
    getRepos: () => [
      { id: 'repo-1', path: repoPath, displayName: 'repo', badgeColor: '#000', addedAt: 0 }
    ],
    getSettings: () => ({})
  } as unknown as Store
}

function nameFilter(query: string): (relativePath: string) => boolean {
  const tokens = splitFileNameFilterTokens(query)
  return (relativePath) => pathMatchesFileNameFilterTokens(relativePath, tokens)
}

function spawnMissingRipgrep(): void {
  wslAwareSpawnMock.mockImplementation(
    (_command: string, _args: string[], options: SpawnOptions & { cwd?: string }) =>
      spawn('orca-definitely-missing-rg', [], { cwd: options.cwd, stdio: options.stdio })
  )
}

function fakeRipgrep(output: string, killSignal: NodeJS.Signals | null = null): EventEmitter {
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
    child.emit('close', killSignal ? null : 0, killSignal)
  }, 0)
  return child
}

describe('listQuickOpenFiles name filter', () => {
  let tempDir: string | null = null

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
      tempDir = null
    }
    vi.clearAllMocks()
  })

  it('counts only matches against the ripgrep cap', async () => {
    wslAwareSpawnMock
      .mockImplementationOnce(() => fakeRipgrep('a.ts\nb.ts\nc.ts\nios/AppDelegate.swift\n'))
      .mockImplementationOnce(() => fakeRipgrep(''))

    const files = await listQuickOpenFiles(
      '/repo',
      makeStore('/repo'),
      undefined,
      undefined,
      2,
      undefined,
      nameFilter('app delegate')
    )

    expect(files).toEqual(['ios/AppDelegate.swift'])
  })

  it('filters the whole git listing when ripgrep is missing', async () => {
    spawnMissingRipgrep()
    tempDir = await mkdtemp(join(tmpdir(), 'orca-name-filter-'))
    const repoPath = join(tempDir, 'repo')
    await execFile('git', ['init', '-q', repoPath])
    for (const relPath of ['a.ts', 'b.ts', 'zz/Notion Web Clipper/AppDelegate.swift']) {
      await mkdir(dirname(join(repoPath, relPath)), { recursive: true })
      await writeFile(join(repoPath, relPath), 'x')
    }
    await execFile('git', ['add', '.'], { cwd: repoPath })
    const store = makeStore(repoPath)

    await expect(listQuickOpenFiles(repoPath, store, undefined, undefined, 2)).resolves.toEqual([
      'a.ts',
      'b.ts'
    ])
    await expect(
      listQuickOpenFiles(repoPath, store, undefined, undefined, 2, undefined, nameFilter('appdel'))
    ).resolves.toEqual(['zz/Notion Web Clipper/AppDelegate.swift'])
  })

  it('rejects an over-budget filtered walk so the renderer keeps its capped listing', async () => {
    spawnMissingRipgrep()
    listFilesWithGitSpy.mockRejectedValueOnce(new Error('File listing exceeded 20001 files'))

    await expect(
      listQuickOpenFiles(
        '/folder',
        makeStore('/folder'),
        undefined,
        undefined,
        5,
        undefined,
        nameFilter('target')
      )
    ).rejects.toThrow()
    expect(listFilesWithGitSpy).toHaveBeenCalledTimes(1)
    expect(listFilesWithGitSpy.mock.calls[0][4]).toBeUndefined()
  })

  it('keeps primary matches when the ignored-file pass fails during a filtered scan', async () => {
    wslAwareSpawnMock
      .mockImplementationOnce(() => fakeRipgrep('ios/AppDelegate.swift\n'))
      .mockImplementationOnce(() => fakeRipgrep('', 'SIGKILL'))

    await expect(
      listQuickOpenFiles(
        '/repo',
        makeStore('/repo'),
        undefined,
        undefined,
        5,
        undefined,
        nameFilter('appdelegate')
      )
    ).resolves.toEqual(['ios/AppDelegate.swift'])
  })

  it('still rejects an ignored-pass failure for unfiltered listings', async () => {
    wslAwareSpawnMock
      .mockImplementationOnce(() => fakeRipgrep('a.ts\n'))
      .mockImplementationOnce(() => fakeRipgrep('', 'SIGKILL'))

    await expect(
      listQuickOpenFiles('/repo', makeStore('/repo'), undefined, undefined, 5)
    ).rejects.toThrow('rg killed by SIGKILL')
  })
})
