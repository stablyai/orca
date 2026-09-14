import path from 'node:path'
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  handlers,
  store,
  showSaveDialogMock,
  showOpenDialogMock,
  fromWebContentsMock,
  statMock,
  openMock,
  renameMock,
  rmMock,
  getSshFilesystemProviderMock,
  promoteLocalDownloadedFolderMock,
  resetFilesystemIpcMocks
} from './filesystem-test-harness'

vi.mock('electron', async () => (await import('./filesystem-test-harness')).electronMock)
vi.mock('fs/promises', async () => (await import('./filesystem-test-harness')).fsPromisesMock)
vi.mock(
  '../wsl-unc-delete',
  async () => (await import('./filesystem-test-harness')).wslUncDeleteMock
)
vi.mock(
  '../crash-reporting/crash-breadcrumb-store',
  async () => (await import('./filesystem-test-harness')).crashBreadcrumbMock
)
vi.mock(
  '../local-downloaded-folder-promotion',
  async () => (await import('./filesystem-test-harness')).folderPromotionMock
)
vi.mock(
  '../git/status',
  async () => (await import('./filesystem-test-harness')).gitStatusModuleMock
)
vi.mock(
  '../git/check-ignored-paths',
  async () => (await import('./filesystem-test-harness')).gitIgnoredPathsMock
)
vi.mock('../git/worktree', async () => (await import('./filesystem-test-harness')).gitWorktreeMock)
vi.mock(
  '../providers/ssh-filesystem-dispatch',
  async () => (await import('./filesystem-test-harness')).sshFilesystemDispatchMock
)
vi.mock(
  '../providers/ssh-git-dispatch',
  async () => (await import('./filesystem-test-harness')).sshGitDispatchMock
)
vi.mock(
  '../text-generation/commit-message-text-generation',
  async () => (await import('./filesystem-test-harness')).textGenerationModuleMock
)
vi.mock(
  '../text-generation/pull-request-context',
  async () => (await import('./filesystem-test-harness')).pullRequestContextMock
)
vi.mock(
  '../source-control/pull-request-template',
  async () => (await import('./filesystem-test-harness')).pullRequestTemplateMock
)
vi.mock(
  '../source-control/pull-request-linked-issue',
  async () => (await import('./filesystem-test-harness')).pullRequestLinkedIssueMock
)

import { registerFilesystemHandlers } from './filesystem'
import { invalidateAuthorizedRootsCache } from './registered-worktree-roots-cache'

describe('registerFilesystemHandlers', () => {
  const folderDownloadSender = Object.assign(new EventEmitter(), {
    isDestroyed: vi.fn(() => false)
  })
  const folderDownloadEvent = { sender: folderDownloadSender }

  beforeEach(() => {
    folderDownloadSender.removeAllListeners()
    folderDownloadSender.isDestroyed.mockReset().mockReturnValue(false)
    resetFilesystemIpcMocks()
    // Reset module-level auth cache so each test starts with a fresh dirty
    // flag — prevents stale worktree data from a prior test's cache rebuild.
    invalidateAuthorizedRootsCache()
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
})
