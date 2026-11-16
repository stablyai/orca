import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (_event: unknown, args: unknown) => Promise<unknown>>()
const { handleMock, copyFileMock, lstatMock, mkdirMock, renameMock, writeFileMock, realpathMock } =
  vi.hoisted(() => ({
    handleMock: vi.fn(),
    copyFileMock: vi.fn(),
    lstatMock: vi.fn(),
    mkdirMock: vi.fn(),
    renameMock: vi.fn(),
    writeFileMock: vi.fn(),
    realpathMock: vi.fn()
  }))

vi.mock('electron', () => ({
  app: { getPath: () => '/orca-test-user-data' },
  ipcMain: { handle: handleMock }
}))

vi.mock('fs/promises', () => ({
  lstat: lstatMock,
  mkdir: mkdirMock,
  rename: renameMock,
  writeFile: writeFileMock,
  realpath: realpathMock,
  copyFile: copyFileMock,
  readdir: vi.fn()
}))

import { registerFilesystemMutationHandlers } from './filesystem-mutations'
import { resetSshConnectionGenerations } from '../../../ssh/connection/authority/ssh-connection-generation'

// Resolve fixture paths like production to preserve cross-platform comparisons.
const REPO_PATH = path.resolve('/workspace/repo')
const WORKSPACE_DIR = path.resolve('/workspace')

const store = {
  getRepos: () => [
    { id: 'repo-1', path: REPO_PATH, displayName: 'repo', badgeColor: '#000', addedAt: 0 }
  ],
  getSettings: () => ({ workspaceDir: WORKSPACE_DIR })
}

function enoent(): Error {
  return Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
}

function mockStats(dev: number, ino: number) {
  return { dev, ino, isDirectory: () => false }
}

describe('registerFilesystemMutationHandlers', () => {
  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    copyFileMock.mockReset()
    lstatMock.mockReset()
    mkdirMock.mockReset()
    renameMock.mockReset()
    writeFileMock.mockReset()
    realpathMock.mockReset()
    resetSshConnectionGenerations()

    handleMock.mockImplementation((channel: string, handler: never) => {
      handlers.set(channel, handler)
    })

    realpathMock.mockImplementation(async (p: string) => p)
    lstatMock.mockRejectedValue(enoent())
    mkdirMock.mockResolvedValue(undefined)
    writeFileMock.mockResolvedValue(undefined)
    renameMock.mockResolvedValue(undefined)
    copyFileMock.mockResolvedValue(undefined)

    registerFilesystemMutationHandlers(store as never)
  })

  it('fails closed when same-entry realpath encounters a permission error', async () => {
    const oldPath = path.resolve('/workspace/repo/README.md')
    const newPath = path.resolve('/workspace/repo/readme.md')
    lstatMock.mockImplementation(async (p: string) => {
      if (p === oldPath || p === newPath) {
        return mockStats(3, 30)
      }
      throw enoent()
    })
    realpathMock.mockRejectedValue(
      Object.assign(new Error('permission denied'), { code: 'EACCES' })
    )

    await expect(handlers.get('fs:rename')!(null, { oldPath, newPath })).rejects.toMatchObject({
      code: 'EACCES'
    })
    expect(renameMock).not.toHaveBeenCalled()
  })
})
