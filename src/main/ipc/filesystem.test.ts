/* eslint-disable max-lines -- Why: filesystem authorization and git/file IPC invariants are exercised end-to-end here, so the scenarios stay together to keep the security boundary readable. */
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (_event: unknown, args: unknown) => Promise<unknown> | unknown>()
const {
  handleMock,
  showSaveDialogMock,
  showOpenDialogMock,
  fromWebContentsMock,
  trashItemMock,
  readdirMock,
  readFileMock,
  writeFileMock,
  statMock,
  openMock,
  renameMock,
  rmMock,
  realpathMock,
  lstatMock,
  commitChangesMock,
  getStatusMock,
  abortMergeMock,
  abortRebaseMock,
  getDiffMock,
  getBranchCompareMock,
  getBranchDiffMock,
  getStagedCommitContextMock,
  stageFileMock,
  bulkStageFilesMock,
  unstageFileMock,
  bulkUnstageFilesMock,
  bulkDiscardChangesMock,
  discardChangesMock,
  checkIgnoredPathsMock,
  listWorktreesMock,
  resolveCommitMessageSettingsMock,
  generateCommitMessageFromContextMock,
  generatePullRequestFieldsFromContextMock,
  discoverCommitMessageModelsLocalMock,
  discoverCommitMessageModelsRemoteMock,
  cancelGenerateCommitMessageLocalMock,
  cancelGeneratePullRequestFieldsLocalMock,
  getSshFilesystemProviderMock,
  getSshGitProviderMock,
  tryDeleteWslUncPathMock,
  recordCrashBreadcrumbMock,
  promoteLocalDownloadedFolderMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  showSaveDialogMock: vi.fn(),
  showOpenDialogMock: vi.fn(),
  fromWebContentsMock: vi.fn(),
  trashItemMock: vi.fn(),
  readdirMock: vi.fn(),
  readFileMock: vi.fn(),
  writeFileMock: vi.fn(),
  statMock: vi.fn(),
  openMock: vi.fn(),
  renameMock: vi.fn(),
  rmMock: vi.fn(),
  realpathMock: vi.fn(),
  lstatMock: vi.fn(),
  commitChangesMock: vi.fn(),
  getStatusMock: vi.fn(),
  abortMergeMock: vi.fn(),
  abortRebaseMock: vi.fn(),
  getDiffMock: vi.fn(),
  getBranchCompareMock: vi.fn(),
  getBranchDiffMock: vi.fn(),
  getStagedCommitContextMock: vi.fn(),
  stageFileMock: vi.fn(),
  bulkStageFilesMock: vi.fn(),
  unstageFileMock: vi.fn(),
  bulkUnstageFilesMock: vi.fn(),
  bulkDiscardChangesMock: vi.fn(),
  discardChangesMock: vi.fn(),
  checkIgnoredPathsMock: vi.fn(),
  listWorktreesMock: vi.fn(),
  resolveCommitMessageSettingsMock: vi.fn(),
  generateCommitMessageFromContextMock: vi.fn(),
  generatePullRequestFieldsFromContextMock: vi.fn(),
  discoverCommitMessageModelsLocalMock: vi.fn(),
  discoverCommitMessageModelsRemoteMock: vi.fn(),
  cancelGenerateCommitMessageLocalMock: vi.fn(),
  cancelGeneratePullRequestFieldsLocalMock: vi.fn(),
  getSshFilesystemProviderMock: vi.fn(),
  getSshGitProviderMock: vi.fn(),
  tryDeleteWslUncPathMock: vi.fn(),
  recordCrashBreadcrumbMock: vi.fn(),
  promoteLocalDownloadedFolderMock: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: fromWebContentsMock
  },
  dialog: {
    showSaveDialog: showSaveDialogMock,
    showOpenDialog: showOpenDialogMock
  },
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
  open: openMock,
  rename: renameMock,
  rm: rmMock,
  realpath: realpathMock,
  lstat: lstatMock
}))

vi.mock('../wsl-unc-delete', () => ({
  tryDeleteWslUncPath: tryDeleteWslUncPathMock
}))

vi.mock('../crash-reporting/crash-breadcrumb-store', () => ({
  recordCrashBreadcrumb: recordCrashBreadcrumbMock
}))

vi.mock('../local-downloaded-folder-promotion', () => ({
  promoteLocalDownloadedFolder: promoteLocalDownloadedFolderMock
}))

vi.mock('../git/status', () => ({
  commitChanges: commitChangesMock,
  getStatus: getStatusMock,
  abortMerge: abortMergeMock,
  abortRebase: abortRebaseMock,
  getDiff: getDiffMock,
  getBranchCompare: getBranchCompareMock,
  getBranchDiff: getBranchDiffMock,
  getStagedCommitContext: getStagedCommitContextMock,
  stageFile: stageFileMock,
  bulkStageFiles: bulkStageFilesMock,
  unstageFile: unstageFileMock,
  bulkUnstageFiles: bulkUnstageFilesMock,
  bulkDiscardChanges: bulkDiscardChangesMock,
  discardChanges: discardChangesMock
}))

vi.mock('../git/check-ignored-paths', () => ({
  checkIgnoredPaths: checkIgnoredPathsMock
}))

vi.mock('../git/worktree', () => ({
  listWorktrees: listWorktreesMock,
  listWorktreesStrict: listWorktreesMock
}))

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: getSshFilesystemProviderMock,
  SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE:
    'Remote connection dropped. Click Reconnect on the SSH target before retrying.',
  requireSshFilesystemProvider: (connectionId: string) => {
    const provider = getSshFilesystemProviderMock(connectionId)
    if (!provider) {
      throw new Error(
        'Remote connection dropped. Click Reconnect on the SSH target before retrying.'
      )
    }
    return provider
  }
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE:
    'Remote connection dropped. Click Reconnect on the SSH target before retrying.'
}))

vi.mock('../text-generation/commit-message-text-generation', () => ({
  resolveCommitMessageSettings: resolveCommitMessageSettingsMock,
  generateCommitMessageFromContext: generateCommitMessageFromContextMock,
  generatePullRequestFieldsFromContext: generatePullRequestFieldsFromContextMock,
  discoverCommitMessageModelsLocal: discoverCommitMessageModelsLocalMock,
  discoverCommitMessageModelsRemote: discoverCommitMessageModelsRemoteMock,
  cancelGenerateCommitMessageLocal: cancelGenerateCommitMessageLocalMock,
  cancelGeneratePullRequestFieldsLocal: cancelGeneratePullRequestFieldsLocalMock
}))

import { registerFilesystemHandlers } from './filesystem'
import { invalidateAuthorizedRootsCache, registerWorktreeRootsForRepo } from './filesystem-auth'

// Why: paths are resolved via path.resolve() in production code, so test
// data must use resolved paths to avoid Unix-vs-Windows mismatches.
const REPO_PATH = path.resolve('/workspace/repo')
const WORKSPACE_DIR = path.resolve('/workspace')
const WORKTREE_FEATURE_PATH = path.resolve('/workspace/repo-feature')

type MockDirEntry = {
  name: string
  directory?: boolean
  file?: boolean
  symlink?: boolean
}

function dirEntry({ name, directory, file, symlink }: MockDirEntry): {
  name: string
  isDirectory: () => boolean
  isFile: () => boolean
  isSymbolicLink: () => boolean
} {
  return {
    name,
    isDirectory: () => directory ?? false,
    isFile: () => file ?? false,
    isSymbolicLink: () => symlink ?? false
  }
}

async function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return await run()
  } finally {
    if (original) {
      Object.defineProperty(process, 'platform', original)
    }
  }
}

describe('registerFilesystemHandlers', () => {
  const folderDownloadSender = Object.assign(new EventEmitter(), {
    isDestroyed: vi.fn(() => false)
  })
  const folderDownloadEvent = { sender: folderDownloadSender }
  const store = {
    getRepos: () => [
      {
        id: 'repo-1',
        path: REPO_PATH,
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 0
      }
    ],
    getSettings: () => ({
      workspaceDir: WORKSPACE_DIR
    })
  }

  beforeEach(() => {
    folderDownloadSender.removeAllListeners()
    folderDownloadSender.isDestroyed.mockReset().mockReturnValue(false)
    handlers.clear()
    for (const mock of [
      handleMock,
      showSaveDialogMock,
      showOpenDialogMock,
      fromWebContentsMock,
      trashItemMock,
      readdirMock,
      readFileMock,
      writeFileMock,
      statMock,
      openMock,
      renameMock,
      rmMock,
      realpathMock,
      lstatMock,
      recordCrashBreadcrumbMock,
      commitChangesMock,
      getStatusMock,
      abortMergeMock,
      abortRebaseMock,
      getDiffMock,
      getBranchCompareMock,
      getBranchDiffMock,
      getStagedCommitContextMock,
      stageFileMock,
      bulkStageFilesMock,
      unstageFileMock,
      bulkUnstageFilesMock,
      bulkDiscardChangesMock,
      discardChangesMock,
      listWorktreesMock,
      resolveCommitMessageSettingsMock,
      generateCommitMessageFromContextMock,
      generatePullRequestFieldsFromContextMock,
      discoverCommitMessageModelsLocalMock,
      discoverCommitMessageModelsRemoteMock,
      cancelGenerateCommitMessageLocalMock,
      cancelGeneratePullRequestFieldsLocalMock,
      getSshFilesystemProviderMock,
      getSshGitProviderMock,
      tryDeleteWslUncPathMock,
      promoteLocalDownloadedFolderMock
    ]) {
      mock.mockReset()
    }

    handleMock.mockImplementation((channel, handler) => {
      handlers.set(channel, handler)
    })

    // Reset module-level auth cache so each test starts with a fresh dirty
    // flag — prevents stale worktree data from a prior test's cache rebuild.
    invalidateAuthorizedRootsCache()

    realpathMock.mockImplementation(async (targetPath: string) => targetPath)
    listWorktreesMock.mockResolvedValue([
      {
        path: WORKTREE_FEATURE_PATH,
        head: 'abc',
        branch: '',
        isBare: false,
        isMainWorktree: false
      }
    ])
    trashItemMock.mockResolvedValue(undefined)
    // Default: not a WSL UNC path, so deletePath falls through to shell.trashItem.
    tryDeleteWslUncPathMock.mockResolvedValue(false)
    promoteLocalDownloadedFolderMock.mockResolvedValue(undefined)
    showSaveDialogMock.mockResolvedValue({ canceled: true })
    showOpenDialogMock.mockResolvedValue({ canceled: true, filePaths: [] })
    fromWebContentsMock.mockReturnValue(null)
    getSshGitProviderMock.mockReturnValue(null)
    statMock.mockResolvedValue({ size: 10, isDirectory: () => false, mtimeMs: 123 })
    renameMock.mockResolvedValue(undefined)
    rmMock.mockResolvedValue(undefined)
    openMock.mockResolvedValue({
      read: vi.fn(async (buffer: Buffer) => {
        buffer.fill(0x61)
        return { bytesRead: buffer.length, buffer }
      }),
      write: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
      close: vi.fn()
    })
    lstatMock.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
  })

  it('returns an actionable reconnect error when the SSH filesystem provider is unavailable', async () => {
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:readDir')!(null, { dirPath: '/remote/repo', connectionId: 'ssh-1' })
    ).rejects.toThrow(
      'Remote connection dropped. Click Reconnect on the SSH target before retrying.'
    )
  })

  // Why: handler-level WSL UNC authorization depends on native Windows path
  // resolution; path-shape classification has separate cross-platform coverage.
  it.runIf(process.platform === 'win32')(
    'records a redacted breadcrumb when fs:readDir throws on a WSL UNC path',
    async () => {
      registerFilesystemHandlers(store as never)
      const wslPath = path.win32.join('\\\\wsl.localhost\\Ubuntu', 'home', 'user', 'repo')
      // resolveAuthorizedPath authorizes the path, then readdir fails (distro stopped).
      realpathMock.mockResolvedValue(wslPath)
      registerWorktreeRootsForRepo(store as never, 'repo-1', [wslPath])
      readdirMock.mockRejectedValue(Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }))

      await expect(handlers.get('fs:readDir')!(null, { dirPath: wslPath })).rejects.toThrow(/EIO/)

      expect(recordCrashBreadcrumbMock).toHaveBeenCalledWith('fs_readdir_error', {
        throwSite: 'readdir',
        errorName: 'Error',
        errorCode: 'EIO',
        hasConnectionId: false,
        isUNC: true,
        isWsl: true
      })
      // The raw path must never appear in the breadcrumb payload.
      const [, breadcrumbData] = recordCrashBreadcrumbMock.mock.calls[0]
      expect(JSON.stringify(breadcrumbData)).not.toContain('user')
    }
  )

  it('records a breadcrumb tagged ssh-provider when the SSH provider is gone', async () => {
    registerFilesystemHandlers(store as never)
    getSshFilesystemProviderMock.mockReturnValue(undefined)

    await expect(
      handlers.get('fs:readDir')!(null, { dirPath: '/remote/repo', connectionId: 'ssh-1' })
    ).rejects.toThrow()

    expect(recordCrashBreadcrumbMock).toHaveBeenCalledWith(
      'fs_readdir_error',
      expect.objectContaining({ throwSite: 'ssh-provider', hasConnectionId: true })
    )
  })

  it('records a breadcrumb tagged authorize when the path is denied', async () => {
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:readDir')!(null, { dirPath: path.resolve('/etc/passwd') })
    ).rejects.toThrow()

    expect(recordCrashBreadcrumbMock).toHaveBeenCalledWith(
      'fs_readdir_error',
      expect.objectContaining({ throwSite: 'authorize', hasConnectionId: false })
    )
  })

  it('does not record a breadcrumb when fs:readDir succeeds', async () => {
    registerFilesystemHandlers(store as never)
    readdirMock.mockResolvedValue([dirEntry({ name: 'file.ts', file: true })])

    await handlers.get('fs:readDir')!(null, { dirPath: REPO_PATH })

    expect(recordCrashBreadcrumbMock).not.toHaveBeenCalled()
  })

  it('rejects remote downloads with missing required arguments', async () => {
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:downloadFile')!({ sender: {} }, { filePath: '  ', connectionId: 'ssh-1' })
    ).rejects.toThrow('filePath is required')
    await expect(
      handlers.get('fs:downloadFile')!({ sender: {} }, { filePath: '/remote/file.txt' })
    ).rejects.toThrow('connectionId is required')

    expect(showSaveDialogMock).not.toHaveBeenCalled()
  })

  it('surfaces provider lookup errors for remote downloads before opening a dialog', async () => {
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:downloadFile')!(
        { sender: {} },
        {
          filePath: '/remote/file.txt',
          connectionId: 'ssh-1'
        }
      )
    ).rejects.toThrow(
      'Remote connection dropped. Click Reconnect on the SSH target before retrying.'
    )

    expect(showSaveDialogMock).not.toHaveBeenCalled()
  })

  it('rejects remote download directories before opening a dialog', async () => {
    const provider = {
      stat: vi.fn().mockResolvedValue({ size: 0, type: 'directory', mtime: 123 }),
      downloadFile: vi.fn()
    }
    getSshFilesystemProviderMock.mockReturnValue(provider)
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:downloadFile')!(
        { sender: {} },
        {
          filePath: '/remote/src',
          connectionId: 'ssh-1'
        }
      )
    ).rejects.toThrow('Cannot download a directory')

    expect(showSaveDialogMock).not.toHaveBeenCalled()
    expect(provider.downloadFile).not.toHaveBeenCalled()
  })

  it('returns canceled remote downloads without transferring', async () => {
    const provider = {
      stat: vi.fn().mockResolvedValue({ size: 10, type: 'file', mtime: 123 }),
      downloadFile: vi.fn()
    }
    getSshFilesystemProviderMock.mockReturnValue(provider)
    showSaveDialogMock.mockResolvedValue({ canceled: true })
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:downloadFile')!(
        { sender: {} },
        {
          filePath: '/remote/report.pdf',
          connectionId: 'ssh-1'
        }
      )
    ).resolves.toEqual({ canceled: true })

    expect(showSaveDialogMock).toHaveBeenCalledWith({ defaultPath: 'report.pdf' })
    expect(statMock).not.toHaveBeenCalled()
    expect(provider.downloadFile).not.toHaveBeenCalled()
  })

  it('parents the remote download save dialog and sanitizes reserved filename suggestions', async () => {
    const parentWindow = { id: 7 }
    const sender = { id: 42 }
    const provider = {
      stat: vi.fn().mockResolvedValue({ size: 10, type: 'file', mtime: 123 }),
      downloadFile: vi.fn()
    }
    getSshFilesystemProviderMock.mockReturnValue(provider)
    fromWebContentsMock.mockReturnValue(parentWindow)
    showSaveDialogMock.mockResolvedValue({ canceled: true })
    registerFilesystemHandlers(store as never)

    await handlers.get('fs:downloadFile')!(
      { sender },
      {
        filePath: 'C:\\repo\\CON.txt',
        connectionId: 'ssh-1'
      }
    )

    expect(fromWebContentsMock).toHaveBeenCalledWith(sender)
    expect(showSaveDialogMock).toHaveBeenCalledWith(parentWindow, { defaultPath: 'download' })
  })

  it('rejects remote downloads when raw provider transfer is unavailable', async () => {
    const provider = {
      stat: vi.fn().mockResolvedValue({ size: 10, type: 'file', mtime: 123 })
    }
    getSshFilesystemProviderMock.mockReturnValue(provider)
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:downloadFile')!(
        { sender: {} },
        {
          filePath: '/remote/file.txt',
          connectionId: 'ssh-1'
        }
      )
    ).rejects.toThrow('Remote file download is unavailable. Reconnect the SSH target and retry.')

    expect(showSaveDialogMock).not.toHaveBeenCalled()
  })

  it('rejects selected local directories before transferring a remote download', async () => {
    const provider = {
      stat: vi.fn().mockResolvedValue({ size: 10, type: 'file', mtime: 123 }),
      downloadFile: vi.fn()
    }
    getSshFilesystemProviderMock.mockReturnValue(provider)
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: '/downloads/report.pdf' })
    statMock.mockResolvedValue({ isDirectory: () => true })
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:downloadFile')!(
        { sender: {} },
        {
          filePath: '/remote/report.pdf',
          connectionId: 'ssh-1'
        }
      )
    ).rejects.toThrow('Cannot download to a directory')

    expect(provider.downloadFile).not.toHaveBeenCalled()
  })

  it('downloads to a temp sibling then promotes a new destination', async () => {
    const provider = {
      stat: vi.fn().mockResolvedValue({ size: 10, type: 'file', mtime: 123 }),
      downloadFile: vi.fn().mockResolvedValue(undefined)
    }
    getSshFilesystemProviderMock.mockReturnValue(provider)
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: '/downloads/report.pdf' })
    statMock.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:downloadFile')!(
        { sender: {} },
        {
          filePath: '/remote/report.pdf',
          connectionId: 'ssh-1'
        }
      )
    ).resolves.toEqual({ canceled: false, destinationPath: '/downloads/report.pdf' })

    const tempPath = provider.downloadFile.mock.calls[0][1]
    expect(path.dirname(tempPath)).toBe(path.normalize('/downloads'))
    expect(provider.downloadFile).toHaveBeenCalledWith('/remote/report.pdf', tempPath)
    expect(renameMock).toHaveBeenCalledWith(tempPath, '/downloads/report.pdf')
    expect(rmMock).not.toHaveBeenCalledWith(tempPath, expect.anything())
  })

  it('streams runtime download chunks to a temp sibling then promotes on finish', async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const close = vi.fn().mockResolvedValue(undefined)
    openMock.mockResolvedValue({ writeFile, close })
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: '/downloads/report.pdf' })
    statMock.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    registerFilesystemHandlers(store as never)

    const started = await handlers.get('fs:startDownloadedFile')!(
      { sender: {} },
      { suggestedName: 'report.pdf' }
    )
    expect(started).toMatchObject({
      canceled: false,
      destinationPath: '/downloads/report.pdf'
    })
    if (!started || typeof started !== 'object' || !('transferId' in started)) {
      throw new Error('download did not start')
    }
    const transferId = started.transferId

    await expect(
      handlers.get('fs:appendDownloadedFileChunk')!(null, {
        transferId,
        contentBase64: Buffer.from('hello').toString('base64')
      })
    ).resolves.toEqual({ ok: true })
    await expect(handlers.get('fs:finishDownloadedFile')!(null, { transferId })).resolves.toEqual({
      canceled: false,
      destinationPath: '/downloads/report.pdf'
    })

    const tempPath = openMock.mock.calls[0][0]
    expect(path.dirname(tempPath)).toBe(path.normalize('/downloads'))
    expect(openMock).toHaveBeenCalledWith(tempPath, 'wx')
    expect(writeFile).toHaveBeenCalledWith(Buffer.from('hello'))
    expect(close).toHaveBeenCalled()
    expect(renameMock).toHaveBeenCalledWith(tempPath, '/downloads/report.pdf')
  })

  it('cleans up a runtime download temp file on cancel', async () => {
    const close = vi.fn().mockResolvedValue(undefined)
    openMock.mockResolvedValue({ writeFile: vi.fn(), close })
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: '/downloads/report.pdf' })
    statMock.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    registerFilesystemHandlers(store as never)

    const started = await handlers.get('fs:startDownloadedFile')!(
      { sender: {} },
      { suggestedName: 'report.pdf' }
    )
    if (!started || typeof started !== 'object' || !('transferId' in started)) {
      throw new Error('download did not start')
    }
    const tempPath = openMock.mock.calls[0][0]

    await expect(
      handlers.get('fs:cancelDownloadedFile')!(null, { transferId: started.transferId })
    ).resolves.toEqual({ ok: true })

    expect(close).toHaveBeenCalled()
    expect(rmMock).toHaveBeenCalledWith(tempPath, { force: true })
    expect(renameMock).not.toHaveBeenCalled()
  })

  it('cleans up the temp sibling when remote download transfer fails', async () => {
    const provider = {
      stat: vi.fn().mockResolvedValue({ size: 10, type: 'file', mtime: 123 }),
      downloadFile: vi.fn().mockRejectedValue(new Error('transfer failed'))
    }
    getSshFilesystemProviderMock.mockReturnValue(provider)
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: '/downloads/report.pdf' })
    statMock.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:downloadFile')!(
        { sender: {} },
        {
          filePath: '/remote/report.pdf',
          connectionId: 'ssh-1'
        }
      )
    ).rejects.toThrow('transfer failed')

    const tempPath = provider.downloadFile.mock.calls[0][1]
    expect(renameMock).not.toHaveBeenCalled()
    expect(rmMock).toHaveBeenCalledWith(tempPath, { force: true })
  })

  it('fails rather than overwriting a destination that appears after the dialog', async () => {
    const provider = {
      stat: vi.fn().mockResolvedValue({ size: 10, type: 'file', mtime: 123 }),
      downloadFile: vi.fn().mockResolvedValue(undefined)
    }
    getSshFilesystemProviderMock.mockReturnValue(provider)
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: '/downloads/report.pdf' })
    statMock
      .mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }))
      .mockResolvedValueOnce({ isDirectory: () => false })
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:downloadFile')!(
        { sender: {} },
        {
          filePath: '/remote/report.pdf',
          connectionId: 'ssh-1'
        }
      )
    ).rejects.toThrow('Destination file appeared before download completed')

    const tempPath = provider.downloadFile.mock.calls[0][1]
    expect(renameMock).not.toHaveBeenCalled()
    expect(rmMock).toHaveBeenCalledWith(tempPath, { force: true })
  })

  it('uses a backup swap when overwriting an existing destination', async () => {
    const provider = {
      stat: vi.fn().mockResolvedValue({ size: 10, type: 'file', mtime: 123 }),
      downloadFile: vi.fn().mockResolvedValue(undefined)
    }
    getSshFilesystemProviderMock.mockReturnValue(provider)
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: '/downloads/report.pdf' })
    statMock.mockResolvedValue({ isDirectory: () => false })
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:downloadFile')!(
        { sender: {} },
        {
          filePath: '/remote/report.pdf',
          connectionId: 'ssh-1'
        }
      )
    ).resolves.toEqual({ canceled: false, destinationPath: '/downloads/report.pdf' })

    const tempPath = provider.downloadFile.mock.calls[0][1]
    const backupPath = renameMock.mock.calls[0][1]
    expect(renameMock.mock.calls[0]).toEqual(['/downloads/report.pdf', backupPath])
    expect(renameMock.mock.calls[1]).toEqual([tempPath, '/downloads/report.pdf'])
    expect(rmMock).toHaveBeenCalledWith(backupPath, { force: true })
  })

  it('downloads remote folders into a temporary sibling before promotion', async () => {
    const provider = {
      stat: vi.fn().mockResolvedValue({ size: 0, type: 'directory', mtime: 123 }),
      downloadFolder: vi.fn().mockResolvedValue(undefined)
    }
    getSshFilesystemProviderMock.mockReturnValue(provider)
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: ['/downloads'] })
    statMock.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:downloadFolder')!(folderDownloadEvent, {
        dirPath: '/remote/src',
        connectionId: 'ssh-1'
      })
    ).resolves.toEqual({ canceled: false, destinationPath: path.join('/downloads', 'src') })

    const tempPath = provider.downloadFolder.mock.calls[0][1]
    expect(path.dirname(tempPath)).toBe(path.normalize('/downloads'))
    expect(showOpenDialogMock).toHaveBeenCalledWith({
      properties: ['openDirectory', 'createDirectory']
    })
    expect(provider.downloadFolder).toHaveBeenCalledWith(
      '/remote/src',
      tempPath,
      expect.objectContaining({ signal: expect.anything() })
    )
    expect(folderDownloadSender.listenerCount('destroyed')).toBe(0)
    expect(promoteLocalDownloadedFolderMock).toHaveBeenCalledWith(
      tempPath,
      path.join('/downloads', 'src'),
      expect.anything()
    )
  })

  it('returns canceled remote folder downloads without transferring', async () => {
    const provider = {
      stat: vi.fn().mockResolvedValue({ size: 0, type: 'directory', mtime: 123 }),
      downloadFolder: vi.fn()
    }
    getSshFilesystemProviderMock.mockReturnValue(provider)
    showOpenDialogMock.mockResolvedValue({ canceled: true, filePaths: [] })
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:downloadFolder')!(folderDownloadEvent, {
        dirPath: '/remote/src',
        connectionId: 'ssh-1'
      })
    ).resolves.toEqual({ canceled: true })

    expect(provider.downloadFolder).not.toHaveBeenCalled()
  })

  it('aborts before opening the folder picker when the renderer is already destroyed', async () => {
    const provider = {
      downloadFolder: vi.fn()
    }
    getSshFilesystemProviderMock.mockReturnValue(provider)
    folderDownloadSender.isDestroyed.mockReturnValue(true)
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:downloadFolder')!(folderDownloadEvent, {
        dirPath: '/remote/src',
        connectionId: 'ssh-1'
      })
    ).rejects.toThrow('window closed')

    expect(showOpenDialogMock).not.toHaveBeenCalled()
    expect(provider.downloadFolder).not.toHaveBeenCalled()
    expect(folderDownloadSender.listenerCount('destroyed')).toBe(0)
  })

  it('opens the folder picker before SSH folder validation', async () => {
    const provider = {
      stat: vi.fn().mockResolvedValue({ size: 0, type: 'directory', mtime: 123 }),
      downloadFolder: vi.fn().mockResolvedValue(undefined)
    }
    getSshFilesystemProviderMock.mockReturnValue(provider)
    showOpenDialogMock.mockImplementation(async () => {
      expect(provider.downloadFolder).not.toHaveBeenCalled()
      return { canceled: false, filePaths: ['/downloads'] }
    })
    statMock.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:downloadFolder')!(folderDownloadEvent, {
        dirPath: '/remote/src',
        connectionId: 'ssh-1'
      })
    ).resolves.toEqual({ canceled: false, destinationPath: path.join('/downloads', 'src') })

    expect(provider.downloadFolder).toHaveBeenCalledTimes(1)
  })

  it('rejects remote folder downloads when the destination folder already exists', async () => {
    const provider = {
      stat: vi.fn().mockResolvedValue({ size: 0, type: 'directory', mtime: 123 }),
      downloadFolder: vi.fn()
    }
    getSshFilesystemProviderMock.mockReturnValue(provider)
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: ['/downloads'] })
    statMock.mockResolvedValue({ isDirectory: () => true })
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:downloadFolder')!(folderDownloadEvent, {
        dirPath: '/remote/src',
        connectionId: 'ssh-1'
      })
    ).rejects.toThrow('Destination folder already exists')

    expect(provider.downloadFolder).not.toHaveBeenCalled()
    expect(promoteLocalDownloadedFolderMock).not.toHaveBeenCalled()
  })

  it('rejects remote folder downloads when the remote path is not a directory', async () => {
    const provider = {
      downloadFolder: vi.fn().mockRejectedValue(new Error('Cannot download a file as a folder'))
    }
    getSshFilesystemProviderMock.mockReturnValue(provider)
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: ['/downloads'] })
    statMock.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:downloadFolder')!(folderDownloadEvent, {
        dirPath: '/remote/file.txt',
        connectionId: 'ssh-1'
      })
    ).rejects.toThrow('Cannot download a file as a folder')

    expect(provider.downloadFolder).toHaveBeenCalledTimes(1)
    expect(promoteLocalDownloadedFolderMock).not.toHaveBeenCalled()
  })

  it('rejects remote folder downloads when the SSH provider cannot transfer folders', async () => {
    const provider = {
      stat: vi.fn().mockResolvedValue({ size: 0, type: 'directory', mtime: 123 })
    }
    getSshFilesystemProviderMock.mockReturnValue(provider)
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: ['/downloads'] })
    statMock.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:downloadFolder')!(folderDownloadEvent, {
        dirPath: '/remote/src',
        connectionId: 'ssh-1'
      })
    ).rejects.toThrow('Remote folder download is unavailable')

    expect(showOpenDialogMock).not.toHaveBeenCalled()
    expect(promoteLocalDownloadedFolderMock).not.toHaveBeenCalled()
  })

  it('cleans up a temporary remote folder download when transfer fails', async () => {
    const provider = {
      stat: vi.fn().mockResolvedValue({ size: 0, type: 'directory', mtime: 123 }),
      downloadFolder: vi.fn().mockRejectedValue(new Error('transfer failed'))
    }
    getSshFilesystemProviderMock.mockReturnValue(provider)
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: ['/downloads'] })
    statMock.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:downloadFolder')!(folderDownloadEvent, {
        dirPath: '/remote/src',
        connectionId: 'ssh-1'
      })
    ).rejects.toThrow('transfer failed')

    const tempPath = provider.downloadFolder.mock.calls[0][1]
    expect(promoteLocalDownloadedFolderMock).not.toHaveBeenCalled()
    expect(rmMock).toHaveBeenCalledWith(tempPath, { recursive: true, force: true })
  })

  it('logs a recursive temporary-folder cleanup failure without masking the transfer error', async () => {
    const provider = {
      downloadFolder: vi.fn().mockRejectedValue(new Error('transfer failed'))
    }
    const cleanupError = new Error('cleanup denied')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    getSshFilesystemProviderMock.mockReturnValue(provider)
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: ['/downloads'] })
    statMock.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    rmMock.mockRejectedValueOnce(cleanupError)
    registerFilesystemHandlers(store as never)

    try {
      await expect(
        handlers.get('fs:downloadFolder')!(folderDownloadEvent, {
          dirPath: '/remote/src',
          connectionId: 'ssh-1'
        })
      ).rejects.toThrow('transfer failed')

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to remove temporary folder download'),
        cleanupError
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('aborts and cleans up a remote folder download when its renderer closes', async () => {
    const provider = {
      stat: vi.fn().mockResolvedValue({ size: 0, type: 'directory', mtime: 123 }),
      downloadFolder: vi.fn(
        (_source: string, _destination: string, options?: { signal?: AbortSignal }) =>
          new Promise<void>((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
              once: true
            })
          })
      )
    }
    getSshFilesystemProviderMock.mockReturnValue(provider)
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: ['/downloads'] })
    statMock.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    registerFilesystemHandlers(store as never)

    const result = handlers.get('fs:downloadFolder')!(folderDownloadEvent, {
      dirPath: '/remote/src',
      connectionId: 'ssh-1'
    })
    await vi.waitFor(() => expect(provider.downloadFolder).toHaveBeenCalledTimes(1))
    folderDownloadSender.emit('destroyed')

    await expect(result).rejects.toThrow('window closed')
    const tempPath = provider.downloadFolder.mock.calls[0][1]
    expect(promoteLocalDownloadedFolderMock).not.toHaveBeenCalled()
    expect(rmMock).toHaveBeenCalledWith(tempPath, { recursive: true, force: true })
    expect(folderDownloadSender.listenerCount('destroyed')).toBe(0)
  })

  it('rejects readFile when the real path escapes allowed roots', async () => {
    const linkPath = path.resolve('/workspace/repo/link.txt')
    realpathMock.mockImplementation(async (targetPath: string) => {
      if (targetPath === linkPath) {
        return path.resolve('/private/secret.txt')
      }
      return targetPath
    })

    registerFilesystemHandlers(store as never)

    await expect(handlers.get('fs:readFile')!(null, { filePath: linkPath })).rejects.toThrow(
      'Access denied: path resolves outside allowed directories'
    )

    expect(readFileMock).not.toHaveBeenCalled()
  })

  it('allows readDir when a registered worktree resolves to a macOS canonical alias', async () => {
    const aliasWorktreePath = path.resolve('/var/folders/orca/worktrees/feature')
    const canonicalWorktreePath = path.resolve('/private/var/folders/orca/worktrees/feature')
    registerWorktreeRootsForRepo(store as never, 'repo-1', [REPO_PATH, aliasWorktreePath])
    realpathMock.mockImplementation(async (targetPath: string) => {
      if (targetPath === aliasWorktreePath) {
        return canonicalWorktreePath
      }
      return targetPath
    })
    readdirMock.mockResolvedValue([dirEntry({ name: 'README.md', file: true })])

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:readDir')!(null, { dirPath: aliasWorktreePath })
    ).resolves.toEqual([{ name: 'README.md', isDirectory: false, isSymlink: false }])

    expect(readdirMock).toHaveBeenCalledWith(canonicalWorktreePath, { withFileTypes: true })
    expect(listWorktreesMock).not.toHaveBeenCalled()
  })

  it('does not follow symlinks when classifying readDir entries', async () => {
    const modelLinkPath = path.join(REPO_PATH, 'Model')
    readdirMock.mockResolvedValue([
      dirEntry({ name: 'README.md', file: true }),
      dirEntry({ name: 'Model', directory: true, symlink: true })
    ])
    statMock.mockImplementation(async (targetPath: string) => ({
      size: 10,
      isDirectory: () => targetPath === modelLinkPath,
      mtimeMs: 123
    }))

    registerFilesystemHandlers(store as never)

    await expect(handlers.get('fs:readDir')!(null, { dirPath: REPO_PATH })).resolves.toEqual([
      { name: 'Model', isDirectory: false, isSymlink: true },
      { name: 'README.md', isDirectory: false, isSymlink: false }
    ])
    expect(statMock).not.toHaveBeenCalledWith(modelLinkPath)
  })

  it('returns false from pathExists when a local authorized path is missing', async () => {
    const targetPath = path.join(REPO_PATH, 'untitled-7.md')
    statMock.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))

    registerFilesystemHandlers(store as never)

    await expect(handlers.get('fs:pathExists')!(null, { filePath: targetPath })).resolves.toBe(
      false
    )

    expect(statMock).toHaveBeenCalledWith(targetPath)
  })

  it('returns false from pathExists when an SSH provider reports a missing path', async () => {
    const provider = {
      stat: vi.fn().mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    }
    getSshFilesystemProviderMock.mockReturnValue(provider)

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:pathExists')!(null, {
        filePath: '/remote/repo/untitled-7.md',
        connectionId: 'ssh-1'
      })
    ).resolves.toBe(false)

    expect(provider.stat).toHaveBeenCalledWith('/remote/repo/untitled-7.md')
  })

  it('allows deletePath when a registered worktree parent resolves to a macOS canonical alias', async () => {
    const aliasWorktreePath = path.resolve('/var/folders/orca/worktrees/feature')
    const canonicalWorktreePath = path.resolve('/private/var/folders/orca/worktrees/feature')
    const aliasFilePath = path.join(aliasWorktreePath, 'README.md')
    const canonicalFilePath = path.join(canonicalWorktreePath, 'README.md')
    registerWorktreeRootsForRepo(store as never, 'repo-1', [REPO_PATH, aliasWorktreePath])
    realpathMock.mockImplementation(async (targetPath: string) => {
      if (targetPath === aliasWorktreePath) {
        return canonicalWorktreePath
      }
      return targetPath
    })

    registerFilesystemHandlers(store as never)

    await handlers.get('fs:deletePath')!(null, { targetPath: aliasFilePath })

    expect(trashItemMock).toHaveBeenCalledWith(canonicalFilePath)
    expect(listWorktreesMock).not.toHaveBeenCalled()
  })

  it('rejects readFile when a symlink in a canonical alias worktree escapes the registered root', async () => {
    const aliasWorktreePath = path.resolve('/var/folders/orca/worktrees/feature')
    const canonicalWorktreePath = path.resolve('/private/var/folders/orca/worktrees/feature')
    const aliasLinkPath = path.join(aliasWorktreePath, 'link.txt')
    registerWorktreeRootsForRepo(store as never, 'repo-1', [REPO_PATH, aliasWorktreePath])
    realpathMock.mockImplementation(async (targetPath: string) => {
      if (targetPath === aliasWorktreePath) {
        return canonicalWorktreePath
      }
      if (targetPath === aliasLinkPath) {
        return path.resolve('/private/secret.txt')
      }
      return targetPath
    })

    registerFilesystemHandlers(store as never)

    await expect(handlers.get('fs:readFile')!(null, { filePath: aliasLinkPath })).rejects.toThrow(
      'Access denied: path resolves outside allowed directories'
    )

    expect(readFileMock).not.toHaveBeenCalled()
  })

  it('does not enumerate worktrees when filesystem handlers register', () => {
    registerFilesystemHandlers(store as never)

    expect(listWorktreesMock).not.toHaveBeenCalled()
  })

  it('rejects writes to directories', async () => {
    lstatMock.mockResolvedValue({ isDirectory: () => true })

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:writeFile')!(null, {
        filePath: path.resolve('/workspace/repo/folder'),
        content: 'data'
      })
    ).rejects.toThrow('Cannot write to a directory')

    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it.each([
    { ext: 'png', mime: 'image/png', data: [0x89, 0x50, 0x4e, 0x47, 0x00] },
    { ext: 'pdf', mime: 'application/pdf', data: [0x25, 0x50, 0x44, 0x46, 0x00] },
    {
      ext: 'svg',
      mime: 'image/svg+xml',
      data: Array.from(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" />'))
    }
  ])('returns base64 content for supported $ext binaries', async ({ ext, mime, data }) => {
    const buf = Buffer.from(data)
    statMock.mockResolvedValue({ size: buf.length, isDirectory: () => false, mtimeMs: 123 })
    readFileMock.mockResolvedValue(buf)
    registerFilesystemHandlers(store as never)
    await expect(
      handlers.get('fs:readFile')!(null, { filePath: path.resolve(`/workspace/repo/file.${ext}`) })
    ).resolves.toEqual({
      content: buf.toString('base64'),
      isBinary: true,
      isImage: true,
      mimeType: mime
    })
  })

  it('opens text files larger than the old 5MB guard', async () => {
    const content = 'a'.repeat(6 * 1024 * 1024)
    statMock.mockResolvedValue({ size: content.length, isDirectory: () => false, mtimeMs: 123 })
    readFileMock.mockResolvedValue(Buffer.from(content))

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:readFile')!(null, { filePath: path.resolve('/workspace/repo/large.json') })
    ).resolves.toEqual({
      content,
      isBinary: false
    })
  })

  it('returns stable byte metadata only for opted-in local log snapshots', async () => {
    const content = Buffer.from('first\npartial')
    const close = vi.fn()
    openMock.mockResolvedValue({
      stat: vi.fn().mockResolvedValue({
        size: content.byteLength,
        dev: 1,
        ino: 2,
        birthtimeMs: 3
      }),
      readFile: vi.fn().mockResolvedValue(content),
      close
    })
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:readFile')!(null, {
        filePath: path.resolve('/workspace/repo/session.jsonl'),
        includeLocalLogMetadata: true
      })
    ).resolves.toEqual({
      content: 'first\npartial',
      isBinary: false,
      fileIdentity: '1:2:3'
    })
    expect(close).toHaveBeenCalledTimes(1)
    expect(readFileMock).not.toHaveBeenCalled()
  })

  it('rejects text files beyond the editor read budget', async () => {
    statMock.mockResolvedValue({ size: 51 * 1024 * 1024, isDirectory: () => false, mtimeMs: 123 })

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:readFile')!(null, { filePath: path.resolve('/workspace/repo/huge.json') })
    ).rejects.toThrow('exceeds 50MB limit')

    expect(readFileMock).not.toHaveBeenCalled()
  })

  it('probes large unknown binaries without reading the full file', async () => {
    statMock.mockResolvedValue({ size: 6 * 1024 * 1024, isDirectory: () => false, mtimeMs: 123 })
    openMock.mockResolvedValue({
      read: vi.fn(async (buffer: Buffer) => {
        buffer[0] = 0x00
        return { bytesRead: 1, buffer }
      }),
      close: vi.fn()
    })

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:readFile')!(null, { filePath: path.resolve('/workspace/repo/archive.bin') })
    ).resolves.toEqual({
      content: '',
      isBinary: true
    })

    expect(readFileMock).not.toHaveBeenCalled()
  })

  it('moves files to trash', async () => {
    registerFilesystemHandlers(store as never)
    const targetPath = path.resolve('/workspace/repo/file.txt')

    await handlers.get('fs:deletePath')!(null, { targetPath })

    expect(trashItemMock).toHaveBeenCalledWith(targetPath)
    expect(tryDeleteWslUncPathMock).toHaveBeenCalledWith(targetPath, { recursive: undefined })
  })

  // Regression for #6415: WSL UNC paths have no Recycle Bin, so shell.trashItem
  // throws. The handler must hard-delete via the distro instead of surfacing an
  // error popup.
  it('hard-deletes a WSL UNC path instead of trashing it', async () => {
    // Why: build the UNC-style root with path.join so it resolves as a real
    // parent/child pair under the host's path semantics. A literal
    // '\\wsl.localhost\...' string only resolves correctly under win32 path
    // rules — on the Linux CI runner POSIX treats the backslashes as filename
    // characters, so the target would not be a descendant of the root and auth
    // would deny it before the WSL hard-delete ran (the real production path is
    // Windows-only).
    const wslUncRoot = path.join(
      `${path.sep}${path.sep}wsl.localhost`,
      'Ubuntu',
      'home',
      'me',
      'repo'
    )
    const targetPath = path.join(wslUncRoot, 'file.txt')
    registerWorktreeRootsForRepo(store as never, 'repo-1', [REPO_PATH, wslUncRoot])
    tryDeleteWslUncPathMock.mockResolvedValue(true)

    registerFilesystemHandlers(store as never)

    await handlers.get('fs:deletePath')!(null, { targetPath, recursive: true })

    expect(tryDeleteWslUncPathMock).toHaveBeenCalledWith(targetPath, { recursive: true })
    // Critical: we must NOT call trashItem for WSL UNC paths — that is exactly
    // the call that throws and produced the user-facing error.
    expect(trashItemMock).not.toHaveBeenCalled()
  })

  it('propagates a WSL hard-delete failure instead of swallowing it', async () => {
    // Why: see sibling test — path.join keeps the UNC root/target a real
    // parent/child pair under both win32 and POSIX (Linux CI) path semantics.
    const wslUncRoot = path.join(
      `${path.sep}${path.sep}wsl.localhost`,
      'Ubuntu',
      'home',
      'me',
      'repo'
    )
    const targetPath = path.join(wslUncRoot, 'file.txt')
    registerWorktreeRootsForRepo(store as never, 'repo-1', [REPO_PATH, wslUncRoot])
    tryDeleteWslUncPathMock.mockRejectedValue(
      new Error('Failed to delete WSL path: Permission denied')
    )

    registerFilesystemHandlers(store as never)

    await expect(handlers.get('fs:deletePath')!(null, { targetPath })).rejects.toThrow(
      'Failed to delete WSL path: Permission denied'
    )
    expect(trashItemMock).not.toHaveBeenCalled()
  })

  it('keeps non-image binaries hidden from the editor payload', async () => {
    statMock.mockResolvedValue({ size: 4, isDirectory: () => false, mtimeMs: 123 })
    readFileMock.mockResolvedValue(Buffer.from([0x00, 0x01, 0x02]))

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:readFile')!(null, { filePath: path.resolve('/workspace/repo/archive.zip') })
    ).resolves.toEqual({
      content: '',
      isBinary: true
    })
  })

  it('normalizes repo worktree paths and keeps git file paths relative', async () => {
    stageFileMock.mockResolvedValue(undefined)

    registerFilesystemHandlers(store as never)

    await handlers.get('git:stage')!(null, {
      worktreePath: WORKTREE_FEATURE_PATH,
      filePath: './src/../src/file.ts'
    })

    // Why: validateGitRelativeFilePath uses path.relative() which produces
    // platform-specific separators (backslashes on Windows).
    expect(stageFileMock).toHaveBeenCalledWith(
      WORKTREE_FEATURE_PATH,
      path.join('src', 'file.ts'),
      {}
    )
  })

  it('uses worktree roots seeded by worktrees:list without rebuilding the cache', async () => {
    registerWorktreeRootsForRepo(store as never, 'repo-1', [REPO_PATH, WORKTREE_FEATURE_PATH])
    getStatusMock.mockResolvedValue({ entries: [] })

    registerFilesystemHandlers(store as never)

    await handlers.get('git:status')!(null, { worktreePath: WORKTREE_FEATURE_PATH })

    expect(listWorktreesMock).not.toHaveBeenCalled()
    expect(realpathMock).not.toHaveBeenCalledWith(WORKTREE_FEATURE_PATH)
    expect(getStatusMock).toHaveBeenCalledWith(WORKTREE_FEATURE_PATH, { includeIgnored: false })
  })

  it('allows git operations on the known repo root without rebuilding the worktree cache', async () => {
    getStatusMock.mockResolvedValue({ entries: [] })

    registerFilesystemHandlers(store as never)

    await handlers.get('git:status')!(null, { worktreePath: REPO_PATH })

    expect(listWorktreesMock).not.toHaveBeenCalled()
    expect(realpathMock).not.toHaveBeenCalledWith(REPO_PATH)
    expect(getStatusMock).toHaveBeenCalledWith(REPO_PATH, { includeIgnored: false })
  })

  it('forwards includeIgnored through local and SSH git status IPC', async () => {
    registerWorktreeRootsForRepo(store as never, 'repo-1', [REPO_PATH, WORKTREE_FEATURE_PATH])
    getStatusMock.mockResolvedValue({ entries: [], conflictOperation: 'unknown' })
    const sshProvider = {
      getStatus: vi.fn().mockResolvedValue({ entries: [], conflictOperation: 'unknown' })
    }
    getSshGitProviderMock.mockReturnValue(sshProvider)

    registerFilesystemHandlers(store as never)

    await handlers.get('git:status')!(null, {
      worktreePath: WORKTREE_FEATURE_PATH,
      includeIgnored: true
    })
    await handlers.get('git:status')!(null, {
      worktreePath: '/remote/repo',
      connectionId: 'ssh-1',
      includeIgnored: true
    })

    expect(getStatusMock).toHaveBeenCalledWith(WORKTREE_FEATURE_PATH, { includeIgnored: true })
    expect(sshProvider.getStatus).toHaveBeenCalledWith('/remote/repo', { includeIgnored: true })
  })

  it('forwards upstream-negative-cache bypass through local and SSH git status IPC', async () => {
    registerWorktreeRootsForRepo(store as never, 'repo-1', [REPO_PATH, WORKTREE_FEATURE_PATH])
    getStatusMock.mockResolvedValue({ entries: [], conflictOperation: 'unknown' })
    const sshProvider = {
      getStatus: vi.fn().mockResolvedValue({ entries: [], conflictOperation: 'unknown' })
    }
    getSshGitProviderMock.mockReturnValue(sshProvider)

    registerFilesystemHandlers(store as never)

    await handlers.get('git:status')!(null, {
      worktreePath: WORKTREE_FEATURE_PATH,
      bypassEffectiveUpstreamNegativeCache: true
    })
    await handlers.get('git:status')!(null, {
      worktreePath: '/remote/repo',
      connectionId: 'ssh-1',
      bypassEffectiveUpstreamNegativeCache: true
    })

    expect(getStatusMock).toHaveBeenCalledWith(WORKTREE_FEATURE_PATH, {
      includeIgnored: false,
      bypassEffectiveUpstreamNegativeCache: true
    })
    expect(sshProvider.getStatus).toHaveBeenCalledWith('/remote/repo', {
      includeIgnored: false,
      bypassEffectiveUpstreamNegativeCache: true
    })
  })

  it('forwards line-stat reuse through local and SSH git status IPC', async () => {
    registerWorktreeRootsForRepo(store as never, 'repo-1', [REPO_PATH, WORKTREE_FEATURE_PATH])
    getStatusMock.mockResolvedValue({ entries: [], conflictOperation: 'unknown' })
    const sshProvider = {
      getStatus: vi.fn().mockResolvedValue({ entries: [], conflictOperation: 'unknown' })
    }
    getSshGitProviderMock.mockReturnValue(sshProvider)
    registerFilesystemHandlers(store as never)

    await handlers.get('git:status')!(null, {
      worktreePath: WORKTREE_FEATURE_PATH,
      reuseLineStats: true
    })
    await handlers.get('git:status')!(null, {
      worktreePath: '/remote/repo',
      connectionId: 'ssh-1',
      reuseLineStats: true
    })

    expect(getStatusMock).toHaveBeenCalledWith(WORKTREE_FEATURE_PATH, {
      includeIgnored: false,
      reuseLineStats: true
    })
    expect(sshProvider.getStatus).toHaveBeenCalledWith('/remote/repo', {
      includeIgnored: false,
      reuseLineStats: true
    })
  })

  it('aborts tokenized local status without crossing renderer boundaries', async () => {
    registerWorktreeRootsForRepo(store as never, 'repo-1', [REPO_PATH, WORKTREE_FEATURE_PATH])
    const statusSignals: AbortSignal[] = []
    getStatusMock.mockImplementation(
      (_worktreePath: string, options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          if (options.signal) {
            statusSignals.push(options.signal)
            options.signal.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true
            })
          }
        })
    )
    registerFilesystemHandlers(store as never)

    const firstEvent = { sender: { id: 7 } }
    const secondEvent = { sender: { id: 8 } }
    const firstRequest = handlers.get('git:status')!(firstEvent, {
      worktreePath: WORKTREE_FEATURE_PATH,
      requestToken: 'status-1'
    }) as Promise<unknown>
    const secondRequest = handlers.get('git:status')!(secondEvent, {
      worktreePath: WORKTREE_FEATURE_PATH,
      requestToken: 'status-1'
    }) as Promise<unknown>
    await vi.waitFor(() => expect(statusSignals).toHaveLength(2))
    await handlers.get('git:cancelStatus')!(firstEvent, { requestToken: 'status-1' })

    expect(statusSignals[0]?.aborted).toBe(true)
    expect(statusSignals[1]?.aborted).toBe(false)
    await expect(firstRequest).rejects.toThrow('aborted')

    await handlers.get('git:cancelStatus')!(secondEvent, { requestToken: 'status-1' })
    await expect(secondRequest).rejects.toThrow('aborted')
  })

  it('checks ignored paths through local and SSH git providers', async () => {
    registerWorktreeRootsForRepo(store as never, 'repo-1', [REPO_PATH, WORKTREE_FEATURE_PATH])
    checkIgnoredPathsMock.mockResolvedValue(['dist/bundle.js'])
    const sshProvider = {
      checkIgnoredPaths: vi.fn().mockResolvedValue(['build/output.js'])
    }
    getSshGitProviderMock.mockReturnValue(sshProvider)

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:checkIgnored')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH,
        paths: ['dist/bundle.js', 'src/index.ts']
      })
    ).resolves.toEqual(['dist/bundle.js'])
    await expect(
      handlers.get('git:checkIgnored')!(null, {
        worktreePath: '/remote/repo',
        connectionId: 'ssh-1',
        paths: ['build/output.js']
      })
    ).resolves.toEqual(['build/output.js'])

    expect(checkIgnoredPathsMock).toHaveBeenCalledWith(
      WORKTREE_FEATURE_PATH,
      [path.join('dist', 'bundle.js'), path.join('src', 'index.ts')],
      {}
    )
    expect(sshProvider.checkIgnoredPaths).toHaveBeenCalledWith('/remote/repo', [
      path.join('build', 'output.js')
    ])
  })

  it('routes abort merge through local and SSH git providers', async () => {
    registerWorktreeRootsForRepo(store as never, 'repo-1', [REPO_PATH, WORKTREE_FEATURE_PATH])
    abortMergeMock.mockResolvedValue(undefined)
    const sshProvider = {
      abortMerge: vi.fn().mockResolvedValue(undefined)
    }
    getSshGitProviderMock.mockReturnValue(sshProvider)

    registerFilesystemHandlers(store as never)

    await handlers.get('git:abortMerge')!(null, { worktreePath: WORKTREE_FEATURE_PATH })
    await handlers.get('git:abortMerge')!(null, {
      worktreePath: '/remote/repo',
      connectionId: 'ssh-1'
    })

    expect(abortMergeMock).toHaveBeenCalledWith(WORKTREE_FEATURE_PATH, {})
    expect(sshProvider.abortMerge).toHaveBeenCalledWith('/remote/repo')
  })

  it('routes abort rebase through local and SSH git providers', async () => {
    registerWorktreeRootsForRepo(store as never, 'repo-1', [REPO_PATH, WORKTREE_FEATURE_PATH])
    abortRebaseMock.mockResolvedValue(undefined)
    const sshProvider = {
      abortRebase: vi.fn().mockResolvedValue(undefined)
    }
    getSshGitProviderMock.mockReturnValue(sshProvider)

    registerFilesystemHandlers(store as never)

    await handlers.get('git:abortRebase')!(null, { worktreePath: WORKTREE_FEATURE_PATH })
    await handlers.get('git:abortRebase')!(null, {
      worktreePath: '/remote/repo',
      connectionId: 'ssh-1'
    })

    expect(abortRebaseMock).toHaveBeenCalledWith(WORKTREE_FEATURE_PATH, {})
    expect(sshProvider.abortRebase).toHaveBeenCalledWith('/remote/repo')
  })

  it('rejects git file paths that escape the selected worktree', async () => {
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:discard')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH,
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
        worktreePath: WORKTREE_FEATURE_PATH
      })
    ).rejects.toThrow('Access denied: unknown repository or worktree path')

    expect(getStatusMock).not.toHaveBeenCalled()
  })

  it('normalizes git file paths for bulk stage requests', async () => {
    bulkStageFilesMock.mockResolvedValue(undefined)

    registerFilesystemHandlers(store as never)

    await handlers.get('git:bulkStage')!(null, {
      worktreePath: WORKTREE_FEATURE_PATH,
      filePaths: ['./src/../src/file.ts', 'nested//child.ts']
    })

    expect(bulkStageFilesMock).toHaveBeenCalledWith(
      WORKTREE_FEATURE_PATH,
      [path.join('src', 'file.ts'), path.join('nested', 'child.ts')],
      {}
    )
  })

  it('normalizes git file paths for bulk discard requests', async () => {
    bulkDiscardChangesMock.mockResolvedValue(undefined)

    registerFilesystemHandlers(store as never)

    await handlers.get('git:bulkDiscard')!(null, {
      worktreePath: WORKTREE_FEATURE_PATH,
      filePaths: ['./src/../src/file.ts', 'nested//child.ts']
    })

    expect(bulkDiscardChangesMock).toHaveBeenCalledWith(
      WORKTREE_FEATURE_PATH,
      [path.join('src', 'file.ts'), path.join('nested', 'child.ts')],
      {}
    )
  })

  it('rejects bulk unstage requests that escape the selected worktree', async () => {
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:bulkUnstage')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH,
        filePaths: ['src/file.ts', '../outside.txt']
      })
    ).rejects.toThrow('Access denied: git file path escapes the selected worktree')

    expect(bulkUnstageFilesMock).not.toHaveBeenCalled()
  })

  it('rejects bulk discard requests that escape the selected worktree', async () => {
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:bulkDiscard')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH,
        filePaths: ['src/file.ts', '../outside.txt']
      })
    ).rejects.toThrow('Access denied: git file path escapes the selected worktree')

    expect(bulkDiscardChangesMock).not.toHaveBeenCalled()
  })

  it('lists markdown documents recursively for a registered worktree', async () => {
    readdirMock.mockImplementation(async (dirPath: string) => {
      if (dirPath === WORKTREE_FEATURE_PATH) {
        return [
          dirEntry({ name: 'README.md', file: true }),
          dirEntry({ name: 'docs', directory: true }),
          dirEntry({ name: 'script.ts', file: true })
        ]
      }
      if (dirPath === path.join(WORKTREE_FEATURE_PATH, 'docs')) {
        return [
          dirEntry({ name: 'Guide.MDX', file: true }),
          dirEntry({ name: 'notes.markdown', file: true })
        ]
      }
      return []
    })

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:listMarkdownDocuments')!(null, {
        rootPath: WORKTREE_FEATURE_PATH
      })
    ).resolves.toEqual([
      {
        filePath: path.join(WORKTREE_FEATURE_PATH, 'docs', 'Guide.MDX'),
        relativePath: 'docs/Guide.MDX',
        basename: 'Guide.MDX',
        name: 'Guide'
      },
      {
        filePath: path.join(WORKTREE_FEATURE_PATH, 'docs', 'notes.markdown'),
        relativePath: 'docs/notes.markdown',
        basename: 'notes.markdown',
        name: 'notes'
      },
      {
        filePath: path.join(WORKTREE_FEATURE_PATH, 'README.md'),
        relativePath: 'README.md',
        basename: 'README.md',
        name: 'README'
      }
    ])
  })

  it('skips ignored and symlinked directories when listing markdown documents', async () => {
    readdirMock.mockImplementation(async (dirPath: string) => {
      if (dirPath === WORKTREE_FEATURE_PATH) {
        return [
          dirEntry({ name: '.git', directory: true }),
          dirEntry({ name: '.hidden', directory: true }),
          dirEntry({ name: '.github', directory: true }),
          dirEntry({ name: 'node_modules', directory: true }),
          dirEntry({ name: 'linked-docs', directory: true, symlink: true }),
          dirEntry({ name: 'visible.md', file: true })
        ]
      }
      if (dirPath === path.join(WORKTREE_FEATURE_PATH, '.github')) {
        return [dirEntry({ name: 'CONTRIBUTING.md', file: true })]
      }
      throw new Error(`Unexpected readdir: ${dirPath}`)
    })

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:listMarkdownDocuments')!(null, {
        rootPath: WORKTREE_FEATURE_PATH
      })
    ).resolves.toEqual([
      {
        filePath: path.join(WORKTREE_FEATURE_PATH, '.github', 'CONTRIBUTING.md'),
        relativePath: '.github/CONTRIBUTING.md',
        basename: 'CONTRIBUTING.md',
        name: 'CONTRIBUTING'
      },
      {
        filePath: path.join(WORKTREE_FEATURE_PATH, 'visible.md'),
        relativePath: 'visible.md',
        basename: 'visible.md',
        name: 'visible'
      }
    ])
  })

  it('rejects markdown document listing for authorized but unregistered roots', async () => {
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:listMarkdownDocuments')!(null, {
        rootPath: path.resolve('/workspace/unregistered')
      })
    ).rejects.toThrow('Access denied: unknown repository or worktree path')

    expect(readdirMock).not.toHaveBeenCalled()
  })

  it('lists remote markdown documents through the SSH filesystem provider', async () => {
    const provider = {
      listFiles: vi
        .fn()
        .mockResolvedValue(['README.md', 'docs/guide.mdx', '../outside.md', 'src/app.ts'])
    }
    getSshFilesystemProviderMock.mockReturnValue(provider)

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:listMarkdownDocuments')!(null, {
        rootPath: '/home/user/project',
        connectionId: 'ssh-1'
      })
    ).resolves.toEqual([
      {
        filePath: '/home/user/project/docs/guide.mdx',
        relativePath: 'docs/guide.mdx',
        basename: 'guide.mdx',
        name: 'guide'
      },
      {
        filePath: '/home/user/project/README.md',
        relativePath: 'README.md',
        basename: 'README.md',
        name: 'README'
      }
    ])
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
      worktreePath: WORKTREE_FEATURE_PATH,
      baseRef: 'origin/main'
    })

    expect(getBranchCompareMock).toHaveBeenCalledWith(WORKTREE_FEATURE_PATH, 'origin/main', {})
  })

  it('routes local git:commit through commitChanges and returns success', async () => {
    commitChangesMock.mockResolvedValue({ success: true })

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:commit')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH,
        message: 'feat: ship commit'
      })
    ).resolves.toEqual({ success: true })

    expect(commitChangesMock).toHaveBeenCalledWith(WORKTREE_FEATURE_PATH, 'feat: ship commit', {})
  })

  it('returns local commit hook failure payload from git:commit', async () => {
    commitChangesMock.mockResolvedValue({ success: false, error: 'hook failed' })

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:commit')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH,
        message: 'feat: ship commit'
      })
    ).resolves.toEqual({ success: false, error: 'hook failed' })
  })

  it('generates a local commit message from main-process staged context', async () => {
    const context = {
      branch: 'feature/ai',
      stagedSummary: 'M\tREADME.md',
      stagedPatch: '+hello'
    }
    const params = { agentId: 'codex', model: 'gpt-5.4-mini', thinkingLevel: 'low' }
    resolveCommitMessageSettingsMock.mockReturnValue({ ok: true, params })
    getStagedCommitContextMock.mockResolvedValue(context)
    generateCommitMessageFromContextMock.mockResolvedValue({
      success: true,
      message: 'Update README'
    })

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:generateCommitMessage')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH
      })
    ).resolves.toEqual({ success: true, message: 'Update README' })

    expect(getStagedCommitContextMock).toHaveBeenCalledWith(WORKTREE_FEATURE_PATH, {})
    expect(generateCommitMessageFromContextMock).toHaveBeenCalledWith(context, params, {
      kind: 'local',
      cwd: WORKTREE_FEATURE_PATH
    })
  })

  it('uses one-shot resolved params for local commit message generation', async () => {
    const context = {
      branch: 'feature/ai',
      stagedSummary: 'M\tREADME.md',
      stagedPatch: '+hello'
    }
    const sourceControlAiResolvedParams = {
      agentId: 'codex' as const,
      model: 'gpt-5.5',
      thinkingLevel: 'high',
      customPrompt: 'Use Conventional Commits.'
    }
    getStagedCommitContextMock.mockResolvedValue(context)
    generateCommitMessageFromContextMock.mockResolvedValue({
      success: true,
      message: 'feat: update readme'
    })

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:generateCommitMessage')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH,
        sourceControlAiResolvedParams
      })
    ).resolves.toEqual({ success: true, message: 'feat: update readme' })

    expect(resolveCommitMessageSettingsMock).not.toHaveBeenCalled()
    expect(generateCommitMessageFromContextMock).toHaveBeenCalledWith(
      context,
      sourceControlAiResolvedParams,
      {
        kind: 'local',
        cwd: WORKTREE_FEATURE_PATH
      }
    )
  })

  it('prepares the selected Codex account home before local generation', async () => {
    const context = {
      branch: 'feature/ai',
      stagedSummary: 'M\tREADME.md',
      stagedPatch: '+hello'
    }
    const params = { agentId: 'codex', model: 'gpt-5.4-mini', thinkingLevel: 'low' }
    resolveCommitMessageSettingsMock.mockReturnValue({ ok: true, params })
    getStagedCommitContextMock.mockResolvedValue(context)
    generateCommitMessageFromContextMock.mockResolvedValue({
      success: true,
      message: 'Update README'
    })

    registerFilesystemHandlers(store as never, {
      prepareForCodexLaunch: () => '/managed/codex-home'
    })

    await handlers.get('git:generateCommitMessage')!(null, {
      worktreePath: WORKTREE_FEATURE_PATH
    })

    expect(generateCommitMessageFromContextMock).toHaveBeenCalledWith(
      context,
      params,
      expect.objectContaining({
        kind: 'local',
        cwd: WORKTREE_FEATURE_PATH,
        env: expect.objectContaining({ CODEX_HOME: '/managed/codex-home' })
      })
    )
  })

  it('prepares the Orca-managed Codex home for the default system selection', async () => {
    const context = {
      branch: 'feature/ai',
      stagedSummary: 'M\tREADME.md',
      stagedPatch: '+hello'
    }
    const params = { agentId: 'codex', model: 'gpt-5.4-mini', thinkingLevel: 'low' }
    resolveCommitMessageSettingsMock.mockReturnValue({ ok: true, params })
    getStagedCommitContextMock.mockResolvedValue(context)
    generateCommitMessageFromContextMock.mockResolvedValue({
      success: true,
      message: 'Update README'
    })

    registerFilesystemHandlers(store as never, {
      prepareForCodexLaunch: () => '/orca-managed/codex-home'
    })

    await handlers.get('git:generateCommitMessage')!(null, {
      worktreePath: WORKTREE_FEATURE_PATH
    })

    expect(generateCommitMessageFromContextMock).toHaveBeenCalledWith(
      context,
      params,
      expect.objectContaining({
        kind: 'local',
        cwd: WORKTREE_FEATURE_PATH,
        env: expect.objectContaining({ CODEX_HOME: '/orca-managed/codex-home' })
      })
    )
  })

  it('routes local WSL project commit-message generation through the project runtime target', async () => {
    await withPlatform('win32', async () => {
      const context = {
        branch: 'feature/ai',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      }
      const params = { agentId: 'codex', model: 'gpt-5.4-mini', thinkingLevel: 'low' }
      const prepareForCodexLaunch = vi.fn(() => '\\\\wsl.localhost\\Ubuntu\\home\\tester\\.codex')
      resolveCommitMessageSettingsMock.mockReturnValue({ ok: true, params })
      getStagedCommitContextMock.mockResolvedValue(context)
      generateCommitMessageFromContextMock.mockResolvedValue({
        success: true,
        message: 'Update README'
      })
      const wslStore = {
        ...store,
        getRepos: () => [
          {
            id: 'repo-1',
            path: WORKTREE_FEATURE_PATH,
            displayName: 'repo',
            badgeColor: '#000',
            addedAt: 0
          }
        ],
        getProjects: () => [
          {
            id: 'project-1',
            sourceRepoIds: ['repo-1'],
            localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
          }
        ],
        getSettings: () => ({
          workspaceDir: WORKSPACE_DIR,
          localWindowsRuntimeDefault: { kind: 'windows-host' }
        })
      }

      registerFilesystemHandlers(wslStore as never, { prepareForCodexLaunch })

      await handlers.get('git:generateCommitMessage')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH
      })

      expect(getStagedCommitContextMock).toHaveBeenCalledWith(WORKTREE_FEATURE_PATH, {
        wslDistro: 'Ubuntu'
      })
      expect(prepareForCodexLaunch).toHaveBeenCalledWith({
        runtime: 'wsl',
        wslDistro: 'Ubuntu'
      })
      expect(generateCommitMessageFromContextMock).toHaveBeenCalledWith(
        context,
        params,
        expect.objectContaining({
          kind: 'local',
          cwd: WORKTREE_FEATURE_PATH,
          wslDistro: 'Ubuntu',
          env: expect.objectContaining({ CODEX_HOME: '/home/tester/.codex' })
        })
      )
    })
  })

  it('returns a sanitized error when local agent account preparation fails', async () => {
    const context = {
      branch: 'feature/ai',
      stagedSummary: 'M\tREADME.md',
      stagedPatch: '+hello'
    }
    const params = { agentId: 'codex', model: 'gpt-5.4-mini', thinkingLevel: 'low' }
    resolveCommitMessageSettingsMock.mockReturnValue({ ok: true, params })
    getStagedCommitContextMock.mockResolvedValue(context)

    registerFilesystemHandlers(store as never, {
      prepareForCodexLaunch: () => {
        throw new Error('failed to read /Users/alice/.codex/auth.json')
      }
    })

    await expect(
      handlers.get('git:generateCommitMessage')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH
      })
    ).resolves.toEqual({
      success: false,
      error: 'Failed to prepare the selected agent account for commit message generation.'
    })
    expect(generateCommitMessageFromContextMock).not.toHaveBeenCalled()
  })

  it('prepares the selected Claude auth environment before local generation', async () => {
    const previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'do-not-leak-managed-auth-conflict'
    const context = {
      branch: 'feature/ai',
      stagedSummary: 'M\tREADME.md',
      stagedPatch: '+hello'
    }
    const params = { agentId: 'claude', model: 'haiku' }
    resolveCommitMessageSettingsMock.mockReturnValue({ ok: true, params })
    getStagedCommitContextMock.mockResolvedValue(context)
    generateCommitMessageFromContextMock.mockResolvedValue({
      success: true,
      message: 'Update README'
    })

    try {
      registerFilesystemHandlers(store as never, {
        prepareForClaudeLaunch: async () => ({
          configDir: '/managed/claude',
          envPatch: { CLAUDE_CONFIG_DIR: '/managed/claude' },
          stripAuthEnv: true,
          provenance: 'managed:account-1'
        })
      })

      await handlers.get('git:generateCommitMessage')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH
      })

      const target = generateCommitMessageFromContextMock.mock.calls[0]?.[2] as
        | { env?: NodeJS.ProcessEnv }
        | undefined
      expect(target?.env).toEqual(
        expect.objectContaining({
          CLAUDE_CONFIG_DIR: '/managed/claude'
        })
      )
      expect(target?.env?.ANTHROPIC_API_KEY).toBeUndefined()
    } finally {
      if (previousAnthropicApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY
      } else {
        process.env.ANTHROPIC_API_KEY = previousAnthropicApiKey
      }
    }
  })

  it('passes per-agent command overrides into local model discovery', async () => {
    discoverCommitMessageModelsLocalMock.mockResolvedValue({
      success: true,
      capability: {
        id: 'codex',
        label: 'Codex',
        modelSource: 'dynamic',
        defaultModelId: 'gpt-5.5',
        models: [{ id: 'gpt-5.5', label: 'GPT-5.5' }]
      },
      models: [{ id: 'gpt-5.5', label: 'GPT-5.5' }],
      defaultModelId: 'gpt-5.5'
    })
    const storeWithOverride = {
      ...store,
      getSettings: () => ({
        workspaceDir: WORKSPACE_DIR,
        agentCmdOverrides: { codex: 'npx codex' }
      })
    }

    registerFilesystemHandlers(storeWithOverride as never)

    await handlers.get('git:discoverCommitMessageModels')!(null, { agentId: 'codex' })

    expect(discoverCommitMessageModelsLocalMock).toHaveBeenCalledWith(
      'codex',
      undefined,
      'npx codex'
    )
  })

  it('routes local WSL project model discovery through the project runtime target', async () => {
    await withPlatform('win32', async () => {
      discoverCommitMessageModelsLocalMock.mockResolvedValue({
        success: true,
        capability: {
          id: 'codex',
          label: 'Codex',
          modelSource: 'dynamic',
          defaultModelId: 'gpt-5.5',
          models: [{ id: 'gpt-5.5', label: 'GPT-5.5' }]
        },
        models: [{ id: 'gpt-5.5', label: 'GPT-5.5' }],
        defaultModelId: 'gpt-5.5'
      })
      const prepareForCodexLaunch = vi.fn(() => '\\\\wsl.localhost\\Ubuntu\\home\\tester\\.codex')
      const wslStore = {
        ...store,
        getRepos: () => [
          {
            id: 'repo-1',
            path: WORKTREE_FEATURE_PATH,
            displayName: 'repo',
            badgeColor: '#000',
            addedAt: 0
          }
        ],
        getProjects: () => [
          {
            id: 'project-1',
            sourceRepoIds: ['repo-1'],
            localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
          }
        ],
        getSettings: () => ({
          workspaceDir: WORKSPACE_DIR,
          agentCmdOverrides: { codex: 'npx codex' },
          localWindowsRuntimeDefault: { kind: 'windows-host' }
        })
      }

      registerFilesystemHandlers(wslStore as never, { prepareForCodexLaunch })

      await handlers.get('git:discoverCommitMessageModels')!(null, {
        agentId: 'codex',
        worktreePath: WORKTREE_FEATURE_PATH
      })

      expect(prepareForCodexLaunch).toHaveBeenCalledWith({
        runtime: 'wsl',
        wslDistro: 'Ubuntu'
      })
      expect(discoverCommitMessageModelsLocalMock).toHaveBeenCalledWith(
        'codex',
        expect.objectContaining({ CODEX_HOME: '/home/tester/.codex' }),
        'npx codex',
        { cwd: WORKTREE_FEATURE_PATH, wslDistro: 'Ubuntu' }
      )
    })
  })

  it('routes SSH model discovery through the remote git provider', async () => {
    discoverCommitMessageModelsRemoteMock.mockResolvedValue({
      success: true,
      capability: {
        id: 'cursor',
        label: 'Cursor',
        modelSource: 'dynamic',
        defaultModelId: 'auto',
        models: [{ id: 'auto', label: 'Auto' }]
      },
      models: [{ id: 'auto', label: 'Auto' }],
      defaultModelId: 'auto'
    })
    const executeCommitMessagePlan = vi.fn()
    getSshGitProviderMock.mockReturnValue({ executeCommitMessagePlan })
    const storeWithOverride = {
      ...store,
      getSettings: () => ({
        workspaceDir: WORKSPACE_DIR,
        agentCmdOverrides: { cursor: 'npx cursor-agent' }
      })
    }

    registerFilesystemHandlers(storeWithOverride as never)

    await handlers.get('git:discoverCommitMessageModels')!(null, {
      agentId: 'cursor',
      worktreePath: '/remote/repo',
      connectionId: 'conn-1'
    })

    expect(discoverCommitMessageModelsRemoteMock).toHaveBeenCalledWith(
      'cursor',
      '/remote/repo',
      expect.any(Function),
      'npx cursor-agent'
    )
    const execute = discoverCommitMessageModelsRemoteMock.mock.calls[0]?.[2] as (
      plan: unknown,
      cwd: string,
      timeoutMs: number
    ) => Promise<unknown>
    await execute({ binary: 'cursor-agent', args: ['--list-models'] }, '/remote/repo', 60_000)
    expect(executeCommitMessagePlan).toHaveBeenCalledWith(
      { binary: 'cursor-agent', args: ['--list-models'] },
      '/remote/repo',
      60_000
    )
    expect(discoverCommitMessageModelsLocalMock).not.toHaveBeenCalled()
  })

  it('generates an SSH commit message using remote staged context and relay execution', async () => {
    const context = {
      branch: 'main',
      stagedSummary: 'A\tremote.txt',
      stagedPatch: '+remote'
    }
    const params = { agentId: 'custom', model: '', customAgentCommand: 'agent' }
    const executeCommitMessagePlan = vi.fn()
    const prepareForCodexLaunch = vi.fn(() => '/managed/codex-home')
    const prepareForClaudeLaunch = vi.fn()
    resolveCommitMessageSettingsMock.mockReturnValue({ ok: true, params })
    getSshGitProviderMock.mockReturnValue({
      getStagedCommitContext: vi.fn().mockResolvedValue(context),
      executeCommitMessagePlan
    })
    generateCommitMessageFromContextMock.mockResolvedValue({
      success: true,
      message: 'Add remote file'
    })

    registerFilesystemHandlers(store as never, {
      prepareForCodexLaunch,
      prepareForClaudeLaunch
    })

    await expect(
      handlers.get('git:generateCommitMessage')!(null, {
        worktreePath: '/remote/repo',
        connectionId: 'conn-1'
      })
    ).resolves.toEqual({ success: true, message: 'Add remote file' })

    expect(generateCommitMessageFromContextMock).toHaveBeenCalledWith(
      context,
      params,
      expect.objectContaining({
        kind: 'remote',
        cwd: '/remote/repo',
        missingBinaryLocation: 'remote PATH'
      })
    )
    const target = generateCommitMessageFromContextMock.mock.calls[0]?.[2]
    await target.execute(
      { binary: 'agent', args: [], stdinPayload: null, label: 'agent' },
      '/cwd',
      1,
      'commit-message'
    )
    expect(executeCommitMessagePlan).toHaveBeenCalledWith(
      { binary: 'agent', args: [], stdinPayload: null, label: 'agent' },
      '/cwd',
      1,
      'commit-message'
    )
    expect(prepareForCodexLaunch).not.toHaveBeenCalled()
    expect(prepareForClaudeLaunch).not.toHaveBeenCalled()
  })

  it('routes SSH generation cancellations to separate provider operations', async () => {
    const cancelGenerateCommitMessage = vi.fn().mockResolvedValue(undefined)
    getSshGitProviderMock.mockReturnValue({ cancelGenerateCommitMessage })

    registerFilesystemHandlers(store as never)

    await handlers.get('git:cancelGenerateCommitMessage')!(null, {
      worktreePath: '/remote/repo',
      connectionId: 'conn-1'
    })
    await handlers.get('git:cancelGeneratePullRequestFields')!(null, {
      worktreePath: '/remote/repo',
      connectionId: 'conn-1'
    })

    expect(cancelGenerateCommitMessage).toHaveBeenNthCalledWith(1, '/remote/repo', 'commit-message')
    expect(cancelGenerateCommitMessage).toHaveBeenNthCalledWith(
      2,
      '/remote/repo',
      'pull-request-fields'
    )
    expect(cancelGenerateCommitMessageLocalMock).not.toHaveBeenCalled()
    expect(cancelGeneratePullRequestFieldsLocalMock).not.toHaveBeenCalled()
  })

  it('does not call the generator when no staged changes exist', async () => {
    resolveCommitMessageSettingsMock.mockReturnValue({
      ok: true,
      params: { agentId: 'codex', model: 'gpt-5.4-mini' }
    })
    getStagedCommitContextMock.mockResolvedValue(null)

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:generateCommitMessage')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH
      })
    ).resolves.toEqual({ success: false, error: 'No staged changes to summarize.' })

    expect(generateCommitMessageFromContextMock).not.toHaveBeenCalled()
  })

  it('sanitizes local staged-context read failures before returning to the renderer', async () => {
    resolveCommitMessageSettingsMock.mockReturnValue({
      ok: true,
      params: { agentId: 'codex', model: 'gpt-5.4-mini' }
    })
    getStagedCommitContextMock.mockRejectedValue(new Error('fatal: /secret/repo failed'))

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:generateCommitMessage')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH
      })
    ).resolves.toEqual({ success: false, error: 'Failed to read staged changes.' })

    expect(generateCommitMessageFromContextMock).not.toHaveBeenCalled()
  })

  it('sanitizes SSH staged-context read failures before returning to the renderer', async () => {
    resolveCommitMessageSettingsMock.mockReturnValue({
      ok: true,
      params: { agentId: 'codex', model: 'gpt-5.4-mini' }
    })
    getSshGitProviderMock.mockReturnValue({
      getStagedCommitContext: vi.fn().mockRejectedValue(new Error('fatal: /remote/secret failed'))
    })

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:generateCommitMessage')!(null, {
        worktreePath: '/remote/repo',
        connectionId: 'conn-1'
      })
    ).resolves.toEqual({ success: false, error: 'Failed to read staged changes.' })

    expect(generateCommitMessageFromContextMock).not.toHaveBeenCalled()
  })

  it('routes ssh git:commit through the SSH provider instead of local commitChanges', async () => {
    const sshCommitMock = vi.fn().mockResolvedValue({ success: true })
    getSshGitProviderMock.mockReturnValue({ commit: sshCommitMock })

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:commit')!(null, {
        worktreePath: '/remote/repo',
        message: 'feat: remote commit',
        connectionId: 'conn-1'
      })
    ).resolves.toEqual({ success: true })

    expect(sshCommitMock).toHaveBeenCalledWith('/remote/repo', 'feat: remote commit')
    expect(commitChangesMock).not.toHaveBeenCalled()
  })

  it('routes ssh git:remoteCommitUrl through the SSH provider', async () => {
    const sha = '0123456789abcdef0123456789abcdef01234567'
    const sshRemoteCommitUrlMock = vi.fn().mockResolvedValue('https://github.com/org/repo/commit/x')
    getSshGitProviderMock.mockReturnValue({ getRemoteCommitUrl: sshRemoteCommitUrlMock })

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:remoteCommitUrl')!(null, {
        worktreePath: '/remote/repo',
        sha,
        connectionId: 'conn-1'
      })
    ).resolves.toBe('https://github.com/org/repo/commit/x')

    expect(sshRemoteCommitUrlMock).toHaveBeenCalledWith('/remote/repo', sha)
  })

  it('rejects git:remoteCommitUrl with a short hash before SSH dispatch', async () => {
    const sshRemoteCommitUrlMock = vi.fn()
    getSshGitProviderMock.mockReturnValue({ getRemoteCommitUrl: sshRemoteCommitUrlMock })

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:remoteCommitUrl')!(null, {
        worktreePath: '/remote/repo',
        sha: 'abc123',
        connectionId: 'conn-1'
      })
    ).rejects.toThrow('sha must be a full git object id')

    expect(sshRemoteCommitUrlMock).not.toHaveBeenCalled()
  })

  it('routes ssh git:bulkDiscard through the SSH provider', async () => {
    const sshBulkDiscardMock = vi.fn().mockResolvedValue(undefined)
    getSshGitProviderMock.mockReturnValue({ bulkDiscardChanges: sshBulkDiscardMock })

    registerFilesystemHandlers(store as never)

    await handlers.get('git:bulkDiscard')!(null, {
      worktreePath: '/remote/repo',
      filePaths: ['a.ts', 'b.ts'],
      connectionId: 'conn-1'
    })

    expect(sshBulkDiscardMock).toHaveBeenCalledWith('/remote/repo', ['a.ts', 'b.ts'])
    expect(bulkDiscardChangesMock).not.toHaveBeenCalled()
  })

  it('routes ssh git:fastForward through the SSH provider', async () => {
    const sshFastForwardMock = vi.fn().mockResolvedValue(undefined)
    const pushTarget = { remoteName: 'fork', branchName: 'feature/fix' }
    getSshGitProviderMock.mockReturnValue({ fastForwardBranch: sshFastForwardMock })

    registerFilesystemHandlers(store as never)

    await handlers.get('git:fastForward')!(null, {
      worktreePath: '/remote/repo',
      connectionId: 'conn-1',
      pushTarget
    })

    expect(sshFastForwardMock).toHaveBeenCalledWith('/remote/repo', pushTarget)
  })

  it('rejects git:commit with empty message and does not call commitChanges', async () => {
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:commit')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH,
        message: ''
      })
    ).rejects.toThrow('Commit message is required')

    expect(commitChangesMock).not.toHaveBeenCalled()
  })

  it('rejects git:commit with whitespace-only message and does not call commitChanges', async () => {
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:commit')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH,
        message: '   '
      })
    ).rejects.toThrow('Commit message is required')

    expect(commitChangesMock).not.toHaveBeenCalled()
  })

  it('rejects git:commit with whitespace-only message before SSH dispatch', async () => {
    const sshCommitMock = vi.fn().mockResolvedValue({ success: true })
    getSshGitProviderMock.mockReturnValue({ commit: sshCommitMock })

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:commit')!(null, {
        worktreePath: '/remote/repo',
        message: '\n',
        connectionId: 'conn-1'
      })
    ).rejects.toThrow('Commit message is required')

    expect(sshCommitMock).not.toHaveBeenCalled()
  })

  it('allows git operations on worktrees outside repo/workspace roots', async () => {
    // Linked worktrees can live anywhere on disk (e.g. ~/.codex/worktrees/).
    // As long as the path matches a worktree reported by `git worktree list`
    // for a registered repo, it should be allowed — the security boundary is
    // worktree registration, not directory containment.
    const externalWorktreePath = path.resolve('/external/worktrees/feature')
    listWorktreesMock.mockResolvedValue([
      {
        path: REPO_PATH,
        head: 'abc',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: externalWorktreePath,
        head: 'def',
        branch: 'refs/heads/feature',
        isBare: false,
        isMainWorktree: false
      }
    ])

    getBranchCompareMock.mockResolvedValue({
      summary: {
        baseRef: 'origin/main',
        baseOid: 'base-oid',
        compareRef: 'feature',
        headOid: 'head-oid',
        mergeBase: 'merge-base-oid',
        changedFiles: 0,
        status: 'ready'
      },
      entries: []
    })

    registerFilesystemHandlers(store as never)

    await handlers.get('git:branchCompare')!(null, {
      worktreePath: externalWorktreePath,
      baseRef: 'origin/main'
    })

    expect(getBranchCompareMock).toHaveBeenCalledWith(externalWorktreePath, 'origin/main', {})
  })

  it('rejects branchCompare for a worktree added after cache was built, then succeeds after invalidation', async () => {
    // Reproduces the bug where CLI-created worktrees fail with
    // "Access denied: unknown repository or worktree path" because the
    // filesystem-auth cache was not invalidated after creation.
    const cliWorktreePath = path.resolve('/external/cli-created-worktree')

    // Step 1: register handlers and trigger initial cache build with only
    // the original worktree in the listing.
    registerFilesystemHandlers(store as never)

    // Warm the cache by calling a git operation on the existing worktree.
    getStatusMock.mockResolvedValue({ entries: [] })
    await handlers.get('git:status')!(null, { worktreePath: WORKTREE_FEATURE_PATH })

    // Step 2: simulate the CLI creating a new worktree — git now lists it,
    // but the auth cache is stale.
    listWorktreesMock.mockResolvedValue([
      {
        path: WORKTREE_FEATURE_PATH,
        head: 'abc',
        branch: '',
        isBare: false,
        isMainWorktree: false
      },
      {
        path: cliWorktreePath,
        head: 'def',
        branch: 'refs/heads/cli-feature',
        isBare: false,
        isMainWorktree: false
      }
    ])

    // Step 3: branchCompare on the new worktree should fail — this is the
    // exact error the user reported.
    await expect(
      handlers.get('git:branchCompare')!(null, {
        worktreePath: cliWorktreePath,
        baseRef: 'origin/main'
      })
    ).rejects.toThrow('Access denied: unknown repository or worktree path')

    // Step 4: invalidate the cache (what our fix does after CLI create).
    invalidateAuthorizedRootsCache()

    // Step 5: the same branchCompare should now succeed.
    getBranchCompareMock.mockResolvedValue({
      summary: {
        baseRef: 'origin/main',
        baseOid: 'base-oid',
        compareRef: 'cli-feature',
        headOid: 'head-oid',
        mergeBase: 'merge-base-oid',
        changedFiles: 0,
        status: 'ready'
      },
      entries: []
    })

    await handlers.get('git:branchCompare')!(null, {
      worktreePath: cliWorktreePath,
      baseRef: 'origin/main'
    })

    expect(getBranchCompareMock).toHaveBeenCalledWith(cliWorktreePath, 'origin/main', {})
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
      worktreePath: WORKTREE_FEATURE_PATH,
      compare: {
        baseRef: 'origin/main',
        baseOid: 'base-oid',
        headOid: 'head-oid',
        mergeBase: 'merge-base-oid'
      },
      filePath: 'src/file.ts',
      oldPath: 'src/old-file.ts'
    })

    // Why: validateGitRelativeFilePath uses path.relative() which produces
    // platform-specific separators (backslashes on Windows).
    expect(getBranchDiffMock).toHaveBeenCalledWith(
      WORKTREE_FEATURE_PATH,
      {
        headOid: 'head-oid',
        mergeBase: 'merge-base-oid',
        filePath: path.join('src', 'file.ts'),
        oldPath: path.join('src', 'old-file.ts')
      },
      {}
    )
  })

  // Why: the original SSH Quick Open bug had two halves — relay-side policy
  // drift AND the main dispatcher silently dropping excludePaths before the
  // provider saw them. This test guards the second half: regardless of
  // relay behavior, a new linked worktree under the root must be forwarded
  // so the remote scan can prune it. See docs/design/share-quick-open-file-listing.md.
  it('fs:listFiles forwards excludePaths to the SSH filesystem provider', async () => {
    const listFilesMock = vi.fn().mockResolvedValue([])
    getSshFilesystemProviderMock.mockReturnValue({ listFiles: listFilesMock })

    registerFilesystemHandlers(store as never)

    await handlers.get('fs:listFiles')!(null, {
      rootPath: '/home/user/repo',
      connectionId: 'conn-1',
      excludePaths: ['/home/user/repo/worktrees/feature']
    })

    expect(listFilesMock).toHaveBeenCalledWith('/home/user/repo', {
      excludePaths: ['/home/user/repo/worktrees/feature']
    })
  })

  // Why #7721: without a cancel path, every workspace switch left the previous
  // workspace's full-tree SSH scan running, stacking scans on the relay until
  // interactive fs.readDir/fs.stat starved past their 30s timeout.
  it('fs:cancelListFiles aborts an in-flight SSH listing by request token (#7721)', async () => {
    let capturedSignal: AbortSignal | undefined
    const listFilesMock = vi.fn(
      (_rootPath: string, options: { signal?: AbortSignal }) =>
        new Promise<string[]>((_resolve, reject) => {
          capturedSignal = options.signal
          options.signal?.addEventListener('abort', () => reject(new Error('listing cancelled')), {
            once: true
          })
        })
    )
    getSshFilesystemProviderMock.mockReturnValue({ listFiles: listFilesMock })

    registerFilesystemHandlers(store as never)

    // Why: cancellation keys are scoped to the issuing webContents, so the
    // cancel must come from the same sender as the listing request.
    const senderEvent = { sender: { id: 7 } }
    const pending = handlers.get('fs:listFiles')!(senderEvent, {
      rootPath: '/home/user/repo',
      connectionId: 'conn-1',
      requestToken: 'token-1'
    }) as Promise<string[]>

    expect(capturedSignal?.aborted).toBe(false)
    await handlers.get('fs:cancelListFiles')!(senderEvent, { requestToken: 'token-1' })
    expect(capturedSignal?.aborted).toBe(true)
    await expect(pending).rejects.toThrow('listing cancelled')

    // Unknown or already-settled tokens are a no-op, not an error.
    expect(() =>
      handlers.get('fs:cancelListFiles')!(senderEvent, { requestToken: 'unknown' })
    ).not.toThrow()
  })
})
