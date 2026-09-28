import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  handlers,
  store,
  showSaveDialogMock,
  showOpenDialogMock,
  statMock,
  getSshFilesystemProviderMock,
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
import type { RemoteDownloadTransferObserver } from '../../shared/remote-download-progress'

describe('remote download progress IPC', () => {
  const sender = Object.assign(new EventEmitter(), {
    id: 7,
    isDestroyed: vi.fn(() => false),
    send: vi.fn()
  })
  const event = { sender }

  beforeEach(() => {
    sender.removeAllListeners()
    sender.send.mockReset()
    resetFilesystemIpcMocks()
    invalidateAuthorizedRootsCache()
    statMock.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    registerFilesystemHandlers(store as never)
  })

  it('reports file progress against the remote size and cancels the transfer on request', async () => {
    let observedSignal: AbortSignal | undefined
    const provider = {
      stat: vi.fn().mockResolvedValue({ size: 10, type: 'file', mtime: 1 }),
      downloadFile: vi.fn(
        (_source: string, _temp: string, observer: RemoteDownloadTransferObserver) =>
          new Promise<void>((_resolve, reject) => {
            observedSignal = observer.signal
            observer.onBytesTransferred?.(4)
            observer.signal?.addEventListener('abort', () => reject(observer.signal?.reason))
          })
      )
    }
    getSshFilesystemProviderMock.mockReturnValue(provider)
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: '/downloads/a.bin' })

    const download = handlers.get('fs:downloadFile')!(event, {
      filePath: '/remote/a.bin',
      connectionId: 'ssh-1',
      downloadId: 'd1'
    })
    await vi.waitFor(() => expect(observedSignal).toBeDefined())

    expect(sender.send).toHaveBeenCalledWith('fs:downloadProgress', {
      downloadId: 'd1',
      transferredBytes: 0,
      totalBytes: 10,
      completedFiles: 0
    })
    await handlers.get('fs:cancelDownload')!(event, { downloadId: 'd1' })
    await expect(download).rejects.toThrow('Download canceled')
    expect(sender.send).toHaveBeenLastCalledWith(
      'fs:downloadProgress',
      expect.objectContaining({ transferredBytes: 4 })
    )
  })

  it('reports folder progress without a total and links cancel to the folder signal', async () => {
    const provider = {
      stat: vi.fn().mockResolvedValue({ size: 0, type: 'directory', mtime: 1 }),
      downloadFolder: vi.fn(
        (_source: string, _temp: string, observer: RemoteDownloadTransferObserver) =>
          new Promise<void>((_resolve, reject) => {
            observer.onBytesTransferred?.(3)
            observer.onFileCompleted?.()
            observer.signal?.addEventListener('abort', () => reject(observer.signal?.reason))
          })
      )
    }
    getSshFilesystemProviderMock.mockReturnValue(provider)
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: ['/downloads'] })

    const download = handlers.get('fs:downloadFolder')!(event, {
      dirPath: '/remote/src',
      connectionId: 'ssh-1',
      downloadId: 'd2'
    })
    await vi.waitFor(() => expect(provider.downloadFolder).toHaveBeenCalled())

    expect(sender.send).toHaveBeenCalledWith(
      'fs:downloadProgress',
      expect.objectContaining({ downloadId: 'd2', totalBytes: null })
    )
    await handlers.get('fs:cancelDownload')!(event, { downloadId: 'd2' })
    await expect(download).rejects.toThrow('Download canceled')
    expect(sender.send).toHaveBeenLastCalledWith(
      'fs:downloadProgress',
      expect.objectContaining({ transferredBytes: 3, completedFiles: 1 })
    )
  })
})
