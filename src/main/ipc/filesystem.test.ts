import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (_event: unknown, args: unknown) => Promise<unknown> | unknown>()
const {
  handleMock,
  readdirMock,
  readFileMock,
  writeFileMock,
  statMock,
  realpathMock,
  lstatMock,
  getStatusMock,
  getDiffMock,
  stageFileMock,
  unstageFileMock,
  discardChangesMock,
  listWorktreesMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  readdirMock: vi.fn(),
  readFileMock: vi.fn(),
  writeFileMock: vi.fn(),
  statMock: vi.fn(),
  realpathMock: vi.fn(),
  lstatMock: vi.fn(),
  getStatusMock: vi.fn(),
  getDiffMock: vi.fn(),
  stageFileMock: vi.fn(),
  unstageFileMock: vi.fn(),
  discardChangesMock: vi.fn(),
  listWorktreesMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock
  }
}))

vi.mock('fs/promises', () => ({
  readdir: readdirMock,
  readFile: readFileMock,
  writeFile: writeFileMock,
  stat: statMock,
  realpath: realpathMock,
  lstat: lstatMock
}))

vi.mock('../git/status', () => ({
  getStatus: getStatusMock,
  getDiff: getDiffMock,
  stageFile: stageFileMock,
  unstageFile: unstageFileMock,
  discardChanges: discardChangesMock
}))

vi.mock('../git/worktree', () => ({
  listWorktrees: listWorktreesMock
}))

import { registerFilesystemHandlers } from './filesystem'

describe('registerFilesystemHandlers', () => {
  const store = {
    getRepos: () => [
      {
        id: 'repo-1',
        path: '/workspace/repo',
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 0
      }
    ],
    getSettings: () => ({
      workspaceDir: '/workspace'
    })
  }

  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    readdirMock.mockReset()
    readFileMock.mockReset()
    writeFileMock.mockReset()
    statMock.mockReset()
    realpathMock.mockReset()
    lstatMock.mockReset()
    getStatusMock.mockReset()
    getDiffMock.mockReset()
    stageFileMock.mockReset()
    unstageFileMock.mockReset()
    discardChangesMock.mockReset()
    listWorktreesMock.mockReset()

    handleMock.mockImplementation((channel, handler) => {
      handlers.set(channel, handler)
    })

    realpathMock.mockImplementation(async (targetPath: string) => targetPath)
    listWorktreesMock.mockResolvedValue([
      { path: '/workspace/repo-feature', head: 'abc', branch: '', isBare: false }
    ])
    statMock.mockResolvedValue({ size: 10, isDirectory: () => false, mtimeMs: 123 })
    lstatMock.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
  })

  it('rejects readFile when the real path escapes allowed roots', async () => {
    realpathMock.mockImplementation(async (targetPath: string) => {
      if (targetPath === '/workspace/repo/link.txt') {
        return '/private/secret.txt'
      }
      return targetPath
    })

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:readFile')!(null, { filePath: '/workspace/repo/link.txt' })
    ).rejects.toThrow('Access denied: path resolves outside allowed directories')

    expect(readFileMock).not.toHaveBeenCalled()
  })

  it('rejects writes to directories', async () => {
    lstatMock.mockResolvedValue({ isDirectory: () => true })

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:writeFile')!(null, {
        filePath: '/workspace/repo/folder',
        content: 'data'
      })
    ).rejects.toThrow('Cannot write to a directory')

    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it('normalizes repo worktree paths and keeps git file paths relative', async () => {
    stageFileMock.mockResolvedValue(undefined)

    registerFilesystemHandlers(store as never)

    await handlers.get('git:stage')!(null, {
      worktreePath: '/workspace/repo-feature',
      filePath: './src/../src/file.ts'
    })

    expect(stageFileMock).toHaveBeenCalledWith('/workspace/repo-feature', 'src/file.ts')
  })

  it('rejects git file paths that escape the selected worktree', async () => {
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:discard')!(null, {
        worktreePath: '/workspace/repo-feature',
        filePath: '../outside.txt'
      })
    ).rejects.toThrow('Access denied: git file path escapes the selected worktree')

    expect(discardChangesMock).not.toHaveBeenCalled()
  })

  it('rejects git operations for unknown worktrees', async () => {
    listWorktreesMock.mockResolvedValue([])

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:status')!(null, {
        worktreePath: '/workspace/repo-feature'
      })
    ).rejects.toThrow('Access denied: unknown repository or worktree path')

    expect(getStatusMock).not.toHaveBeenCalled()
  })
})
