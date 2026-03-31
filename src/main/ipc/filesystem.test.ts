import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (_event: unknown, args: unknown) => Promise<unknown> | unknown>()
const {
  handleMock,
  trashItemMock,
  readdirMock,
  readFileMock,
  writeFileMock,
  statMock,
  realpathMock,
  lstatMock,
  getStatusMock,
  getDiffMock,
  getBranchCompareMock,
  getBranchDiffMock,
  stageFileMock,
  unstageFileMock,
  discardChangesMock,
  listWorktreesMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  trashItemMock: vi.fn(),
  readdirMock: vi.fn(),
  readFileMock: vi.fn(),
  writeFileMock: vi.fn(),
  statMock: vi.fn(),
  realpathMock: vi.fn(),
  lstatMock: vi.fn(),
  getStatusMock: vi.fn(),
  getDiffMock: vi.fn(),
  getBranchCompareMock: vi.fn(),
  getBranchDiffMock: vi.fn(),
  stageFileMock: vi.fn(),
  unstageFileMock: vi.fn(),
  discardChangesMock: vi.fn(),
  listWorktreesMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock
  },
  shell: {
    trashItem: trashItemMock
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
  getBranchCompare: getBranchCompareMock,
  getBranchDiff: getBranchDiffMock,
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
    trashItemMock.mockReset()
    readdirMock.mockReset()
    readFileMock.mockReset()
    writeFileMock.mockReset()
    statMock.mockReset()
    realpathMock.mockReset()
    lstatMock.mockReset()
    getStatusMock.mockReset()
    getDiffMock.mockReset()
    getBranchCompareMock.mockReset()
    getBranchDiffMock.mockReset()
    stageFileMock.mockReset()
    unstageFileMock.mockReset()
    discardChangesMock.mockReset()
    listWorktreesMock.mockReset()

    handleMock.mockImplementation((channel, handler) => {
      handlers.set(channel, handler)
    })

    realpathMock.mockImplementation(async (targetPath: string) => targetPath)
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/repo-feature',
        head: 'abc',
        branch: '',
        isBare: false,
        isMainWorktree: false
      }
    ])
    trashItemMock.mockResolvedValue(undefined)
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

  it('returns base64 content for supported image binaries', async () => {
    statMock.mockResolvedValue({ size: 4, isDirectory: () => false, mtimeMs: 123 })
    readFileMock.mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]))

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:readFile')!(null, { filePath: '/workspace/repo/image.png' })
    ).resolves.toEqual({
      content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]).toString('base64'),
      isBinary: true,
      isImage: true,
      mimeType: 'image/png'
    })
  })

  it('returns base64 content for supported text-based images', async () => {
    statMock.mockResolvedValue({ size: 32, isDirectory: () => false, mtimeMs: 123 })
    readFileMock.mockResolvedValue(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" />'))

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:readFile')!(null, { filePath: '/workspace/repo/image.svg' })
    ).resolves.toEqual({
      content: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" />').toString('base64'),
      isBinary: true,
      isImage: true,
      mimeType: 'image/svg+xml'
    })
  })

  it('moves files to trash', async () => {
    registerFilesystemHandlers(store as never)

    await handlers.get('fs:deletePath')!(null, { targetPath: '/workspace/repo/file.txt' })

    expect(trashItemMock).toHaveBeenCalledWith('/workspace/repo/file.txt')
  })

  it('keeps non-image binaries hidden from the editor payload', async () => {
    statMock.mockResolvedValue({ size: 4, isDirectory: () => false, mtimeMs: 123 })
    readFileMock.mockResolvedValue(Buffer.from([0x00, 0x01, 0x02]))

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:readFile')!(null, { filePath: '/workspace/repo/archive.zip' })
    ).resolves.toEqual({
      content: '',
      isBinary: true
    })
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

  it('routes branch compare queries through the git compare helper', async () => {
    getBranchCompareMock.mockResolvedValue({
      summary: {
        baseRef: 'origin/main',
        baseOid: 'base-oid',
        compareRef: 'main',
        headOid: 'head-oid',
        mergeBase: 'merge-base-oid',
        changedFiles: 1,
        status: 'ready'
      },
      entries: [{ path: 'src/file.ts', status: 'modified' }]
    })

    registerFilesystemHandlers(store as never)

    await handlers.get('git:branchCompare')!(null, {
      worktreePath: '/workspace/repo-feature',
      baseRef: 'origin/main'
    })

    expect(getBranchCompareMock).toHaveBeenCalledWith('/workspace/repo-feature', 'origin/main')
  })

  it('routes branch diff queries through the pinned branch diff helper', async () => {
    getBranchDiffMock.mockResolvedValue({
      kind: 'text',
      originalContent: 'left',
      modifiedContent: 'right',
      originalIsBinary: false,
      modifiedIsBinary: false
    })

    registerFilesystemHandlers(store as never)

    await handlers.get('git:branchDiff')!(null, {
      worktreePath: '/workspace/repo-feature',
      compare: {
        baseRef: 'origin/main',
        baseOid: 'base-oid',
        headOid: 'head-oid',
        mergeBase: 'merge-base-oid'
      },
      filePath: 'src/file.ts',
      oldPath: 'src/old-file.ts'
    })

    expect(getBranchDiffMock).toHaveBeenCalledWith('/workspace/repo-feature', {
      headOid: 'head-oid',
      mergeBase: 'merge-base-oid',
      filePath: 'src/file.ts',
      oldPath: 'src/old-file.ts'
    })
  })
})
