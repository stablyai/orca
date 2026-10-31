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
  writeFileMock,
  resetFilesystemIpcMocks
} from './filesystem-test-harness'

vi.mock('electron', async () => (await import('./filesystem-test-harness')).electronMock)
vi.mock('fs/promises', async () => (await import('./filesystem-test-harness')).fsPromisesMock)
vi.mock(
  '../../wsl-unc-delete',
  async () => (await import('./filesystem-test-harness')).wslUncDeleteMock
)
vi.mock(
  '../../crash-reporting/crash-breadcrumb-store',
  async () => (await import('./filesystem-test-harness')).crashBreadcrumbMock
)
vi.mock(
  '../../git/status',
  async () => (await import('./filesystem-test-harness')).gitStatusModuleMock
)
vi.mock(
  '../../git/check-ignored-paths',
  async () => (await import('./filesystem-test-harness')).gitIgnoredPathsMock
)
vi.mock(
  '../../git/worktree',
  async () => (await import('./filesystem-test-harness')).gitWorktreeMock
)
vi.mock(
  '../../text-generation/commit-message-text-generation',
  async () => (await import('./filesystem-test-harness')).textGenerationModuleMock
)
vi.mock(
  '../../text-generation/pull-request-context',
  async () => (await import('./filesystem-test-harness')).pullRequestContextMock
)
vi.mock(
  '../../source-control/pull-request-template',
  async () => (await import('./filesystem-test-harness')).pullRequestTemplateMock
)
vi.mock(
  '../../source-control/pull-request-linked-issue',
  async () => (await import('./filesystem-test-harness')).pullRequestLinkedIssueMock
)

import { registerFilesystemHandlers } from './filesystem'
import { invalidateAuthorizedRootsCache } from '../registered-worktree-roots-cache'

describe('registerFilesystemHandlers', () => {
  const folderDownloadSender = Object.assign(new EventEmitter(), {
    isDestroyed: vi.fn(() => false)
  })
  const folderDownloadEvent = { sender: folderDownloadSender }

  beforeEach(() => {
    folderDownloadSender.removeAllListeners()
    folderDownloadSender.isDestroyed.mockReset().mockReturnValue(false)
    resetFilesystemIpcMocks()
    // Drop cached roots between fixtures.
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

  it('parents the save dialog and sanitizes reserved filename suggestions', async () => {
    const parentWindow = { id: 7 }
    const sender = { id: 42 }
    fromWebContentsMock.mockReturnValue(parentWindow)
    showSaveDialogMock.mockResolvedValue({ canceled: true })
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:saveDownloadedFile')!({ sender }, { suggestedName: 'CON.txt', content: '' })
    ).resolves.toEqual({ canceled: true })

    expect(fromWebContentsMock).toHaveBeenCalledWith(sender)
    expect(showSaveDialogMock).toHaveBeenCalledWith(parentWindow, { defaultPath: 'download' })
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it('rejects selected local directories before writing a download', async () => {
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: '/downloads/report.pdf' })
    statMock.mockResolvedValue({ isDirectory: () => true })
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:saveDownloadedFile')!(
        { sender: {} },
        { suggestedName: 'report.pdf', content: 'hello' }
      )
    ).rejects.toThrow('Cannot download to a directory')

    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it('writes to a temp sibling then promotes a new destination', async () => {
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: '/downloads/report.pdf' })
    statMock.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    writeFileMock.mockResolvedValue(undefined)
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:saveDownloadedFile')!(
        { sender: {} },
        { suggestedName: 'report.pdf', content: 'hello' }
      )
    ).resolves.toEqual({ canceled: false, destinationPath: '/downloads/report.pdf' })

    const tempPath = writeFileMock.mock.calls[0][0]
    expect(path.dirname(tempPath)).toBe(path.normalize('/downloads'))
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

    const started = await handlers.get('fs:startDownloadedFile')!(folderDownloadEvent, {
      suggestedName: 'report.pdf'
    })
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

    const started = await handlers.get('fs:startDownloadedFile')!(folderDownloadEvent, {
      suggestedName: 'report.pdf'
    })
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

  it('cleans up the temp sibling when writing a download fails', async () => {
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: '/downloads/report.pdf' })
    statMock.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    writeFileMock.mockRejectedValue(new Error('write failed'))
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:saveDownloadedFile')!(
        { sender: {} },
        { suggestedName: 'report.pdf', content: 'hello' }
      )
    ).rejects.toThrow('write failed')

    const tempPath = writeFileMock.mock.calls[0][0]
    expect(renameMock).not.toHaveBeenCalled()
    expect(rmMock).toHaveBeenCalledWith(tempPath, { force: true })
  })

  it('fails rather than overwriting a destination that appears after the dialog', async () => {
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: '/downloads/report.pdf' })
    statMock
      .mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }))
      .mockResolvedValueOnce({ isDirectory: () => false })
    writeFileMock.mockResolvedValue(undefined)
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:saveDownloadedFile')!(
        { sender: {} },
        { suggestedName: 'report.pdf', content: 'hello' }
      )
    ).rejects.toThrow('Destination file appeared before download completed')

    const tempPath = writeFileMock.mock.calls[0][0]
    expect(renameMock).not.toHaveBeenCalled()
    expect(rmMock).toHaveBeenCalledWith(tempPath, { force: true })
  })

  it('uses a backup swap when overwriting an existing destination', async () => {
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: '/downloads/report.pdf' })
    statMock.mockResolvedValue({ isDirectory: () => false })
    writeFileMock.mockResolvedValue(undefined)
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:saveDownloadedFile')!(
        { sender: {} },
        { suggestedName: 'report.pdf', content: 'hello' }
      )
    ).resolves.toEqual({ canceled: false, destinationPath: '/downloads/report.pdf' })

    const tempPath = writeFileMock.mock.calls[0][0]
    const backupPath = renameMock.mock.calls[0][1]
    expect(renameMock.mock.calls[0]).toEqual(['/downloads/report.pdf', backupPath])
    expect(renameMock.mock.calls[1]).toEqual([tempPath, '/downloads/report.pdf'])
    expect(rmMock).toHaveBeenCalledWith(backupPath, { force: true })
  })

  it('refuses remote folder downloads before opening a picker', async () => {
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('fs:downloadFolder')!(folderDownloadEvent, {
        dirPath: '/remote/src',
        connectionId: 'ssh-1'
      })
    ).rejects.toThrow(
      'Remote connection dropped. Click Reconnect on the SSH target before retrying.'
    )

    expect(showOpenDialogMock).not.toHaveBeenCalled()
  })
})
