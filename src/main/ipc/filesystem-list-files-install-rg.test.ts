import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type * as GitRunner from '../git/runner'

const {
  listFilesWithGitMock,
  resolveAuthorizedPathMock,
  checkRgAvailableMock,
  getLocalGitOptionsForRegisteredWorktreeMock,
  wslAwareSpawnMock
} = vi.hoisted(() => ({
  listFilesWithGitMock: vi.fn(),
  resolveAuthorizedPathMock: vi.fn(),
  checkRgAvailableMock: vi.fn(),
  getLocalGitOptionsForRegisteredWorktreeMock: vi.fn(),
  wslAwareSpawnMock: vi.fn()
}))

vi.mock('./filesystem-list-files-git-fallback', () => ({
  listFilesWithGit: listFilesWithGitMock
}))

vi.mock('./filesystem-auth', () => ({
  resolveAuthorizedPath: resolveAuthorizedPathMock
}))

vi.mock('./rg-availability', () => ({
  checkRgAvailable: checkRgAvailableMock
}))

vi.mock('./local-worktree-runtime-options', () => ({
  getLocalGitOptionsForRegisteredWorktree: getLocalGitOptionsForRegisteredWorktreeMock
}))

vi.mock('../git/runner', async (importOriginal) => ({
  ...(await importOriginal<typeof GitRunner>()),
  wslAwareSpawn: wslAwareSpawnMock
}))

import { listQuickOpenFiles } from './filesystem-list-files'

function createStartedRipgrepProcess(): ChildProcess {
  const child = new EventEmitter() as ChildProcess
  ;(child as unknown as Record<string, unknown>).stdout = new EventEmitter()
  ;(
    (child as unknown as Record<string, unknown>).stdout as EventEmitter & {
      setEncoding: () => void
    }
  ).setEncoding = vi.fn()
  ;(child as unknown as Record<string, unknown>).stderr = new EventEmitter()
  ;(child as unknown as Record<string, unknown>).kill = vi.fn()
  ;(child as unknown as Record<string, unknown>).exitCode = null
  ;(child as unknown as Record<string, unknown>).signalCode = null
  Object.defineProperty(child, 'pid', { value: 1 })
  return child
}

describe('filesystem-list-files ripgrep guidance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveAuthorizedPathMock.mockImplementation(async (path) => path)
    checkRgAvailableMock.mockResolvedValue(true)
    getLocalGitOptionsForRegisteredWorktreeMock.mockReturnValue({})
    wslAwareSpawnMock.mockImplementation(
      (_command: string, _args: string[], options: SpawnOptions & { cwd?: string }) =>
        spawn('orca-definitely-missing-rg', [], { stdio: options.stdio })
    )
  })

  it('turns only a readdir budget failure into install guidance', async () => {
    listFilesWithGitMock.mockRejectedValue(new Error('File listing exceeded 10000 files'))
    const rejection = listQuickOpenFiles('/workspace', {} as Store)

    await expect(rejection).rejects.toThrow(
      'Quick Open scan too large (File listing exceeded 10000 files).'
    )
    await rejection.catch((error: Error) =>
      expect(error.message).toContain('Install ripgrep on the host running the Quick Open scan')
    )
  })

  it('keeps the WSL preflight and falls back before starting real rg', async () => {
    getLocalGitOptionsForRegisteredWorktreeMock.mockReturnValue({ wslDistro: 'Ubuntu' })
    checkRgAvailableMock.mockResolvedValue(false)
    listFilesWithGitMock.mockResolvedValue(['src/index.ts'])

    await expect(listQuickOpenFiles('C:\\repo', {} as Store)).resolves.toEqual(['src/index.ts'])
    expect(checkRgAvailableMock).toHaveBeenCalledWith('C:\\repo', 'Ubuntu')
    expect(wslAwareSpawnMock).not.toHaveBeenCalled()
  })

  it("falls back when a native launcher exits outside ripgrep's contract", async () => {
    const primary = createStartedRipgrepProcess()
    const ignored = createStartedRipgrepProcess()
    let callIndex = 0
    wslAwareSpawnMock.mockImplementation(() => (++callIndex === 1 ? primary : ignored))
    listFilesWithGitMock.mockResolvedValue(['src/index.ts'])

    const listing = listQuickOpenFiles('/workspace', {} as Store)
    await Promise.resolve()
    primary.emit('close', 127, null)

    await expect(listing).resolves.toEqual(['src/index.ts'])
    expect(listFilesWithGitMock).toHaveBeenCalledTimes(1)
  })

  it('keeps cancellation and Git errors unchanged', async () => {
    const cancellation = new Error('File listing cancelled')
    listFilesWithGitMock.mockRejectedValueOnce(cancellation)
    await expect(listQuickOpenFiles('/workspace', {} as Store)).rejects.toBe(cancellation)

    const gitFailure = new Error('git ls-files exited with code 128')
    listFilesWithGitMock.mockRejectedValueOnce(gitFailure)
    await expect(listQuickOpenFiles('/workspace', {} as Store)).rejects.toBe(gitFailure)
  })

  it.skipIf(process.platform !== 'darwin')('shows the macOS install command', async () => {
    listFilesWithGitMock.mockRejectedValue(new Error('File listing timed out'))

    await expect(listQuickOpenFiles('/workspace', {} as Store)).rejects.toThrow(
      'brew install ripgrep'
    )
  })
})
