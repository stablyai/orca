import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  cleanupLegacyRemoteClipboardStagingMock,
  createRemoteClipboardTransferDirectoryMock,
  downloadFileMock,
  requireSshFilesystemProviderMock,
  RemoteClipboardStagingRootUnsafeErrorMock,
  spanFailMock,
  startSpanMock
} = vi.hoisted(() => {
  class RemoteClipboardStagingRootUnsafeErrorMock extends Error {}
  const spanFailMock = vi.fn()
  return {
    cleanupLegacyRemoteClipboardStagingMock: vi.fn(async () => undefined),
    createRemoteClipboardTransferDirectoryMock: vi.fn(),
    downloadFileMock: vi.fn(),
    requireSshFilesystemProviderMock: vi.fn(),
    RemoteClipboardStagingRootUnsafeErrorMock,
    spanFailMock,
    startSpanMock: vi.fn(() => ({ fail: spanFailMock }))
  }
})

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))
vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  requireSshFilesystemProvider: requireSshFilesystemProviderMock
}))
vi.mock('../observability/tracer', () => ({ startSpan: startSpanMock }))
vi.mock('./clipboard-file-copy', () => ({ writeFileToClipboard: vi.fn() }))
vi.mock('./clipboard-remote-file-staging', () => ({
  cleanupExpiredRemoteClipboardStaging: vi.fn(async () => undefined),
  cleanupLegacyRemoteClipboardStaging: cleanupLegacyRemoteClipboardStagingMock,
  createRemoteClipboardTransferDirectory: createRemoteClipboardTransferDirectoryMock,
  RemoteClipboardStagingRootUnsafeError: RemoteClipboardStagingRootUnsafeErrorMock,
  removeRemoteClipboardTransferDirectory: vi.fn(),
  scheduleRemoteClipboardTransferCleanup: vi.fn()
}))

import {
  scheduleLegacyRemoteClipboardFileCleanup,
  writeRemoteFileToClipboard
} from './clipboard-remote-file-copy'
import { RemoteClipboardStagingRootUnsafeError } from './clipboard-remote-file-staging'

beforeEach(() => {
  vi.clearAllMocks()
  requireSshFilesystemProviderMock.mockReturnValue({
    stat: vi.fn(async () => ({ type: 'file' })),
    downloadFile: downloadFileMock
  })
})

describe('remote clipboard staging failures', () => {
  it('rejects remote directories before creating staging', async () => {
    requireSshFilesystemProviderMock.mockReturnValue({
      stat: vi.fn(async () => ({ type: 'directory' })),
      downloadFile: downloadFileMock
    })

    await expect(
      writeRemoteFileToClipboard({
        remotePath: '/repo/src',
        connectionId: 'ssh-1',
        deps: {
          platform: 'win32',
          writeBuffer: vi.fn(),
          runCommand: vi.fn()
        }
      })
    ).resolves.toEqual({ ok: false, reason: 'is-directory' })

    expect(createRemoteClipboardTransferDirectoryMock).not.toHaveBeenCalled()
    expect(downloadFileMock).not.toHaveBeenCalled()
  })

  it.each([
    {
      category: 'unsafe-root',
      error: new RemoteClipboardStagingRootUnsafeError()
    },
    {
      category: 'permissions',
      error: Object.assign(new Error('access denied'), { code: 'EACCES' })
    },
    {
      category: 'permissions',
      error: Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    },
    {
      category: 'path-conflict',
      error: Object.assign(new Error('path exists'), { code: 'EEXIST' })
    },
    {
      category: 'unavailable',
      error: new Error('storage offline')
    }
  ])(
    'returns a toast-safe reason and records $category diagnostics',
    async ({ category, error }) => {
      createRemoteClipboardTransferDirectoryMock.mockRejectedValueOnce(error)

      await expect(
        writeRemoteFileToClipboard({
          remotePath: '/repo/readme.md',
          connectionId: 'ssh-1',
          deps: {
            platform: 'win32',
            writeBuffer: vi.fn(),
            runCommand: vi.fn()
          }
        })
      ).resolves.toEqual({ ok: false, reason: 'staging-unavailable' })

      expect(startSpanMock).toHaveBeenCalledWith('clipboard.remote_staging_init', {
        attributes: {
          operation: 'create',
          platform: process.platform,
          failure_category: category
        }
      })
      expect(spanFailMock).toHaveBeenCalledWith(error)
      expect(downloadFileMock).not.toHaveBeenCalled()
    }
  )
})

describe('legacy remote clipboard cleanup scheduling', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('runs the shared-root compatibility scan once after the startup delay', async () => {
    vi.useFakeTimers()
    vi.spyOn(Date, 'now').mockReturnValue(1_760_000_000_000)

    scheduleLegacyRemoteClipboardFileCleanup()
    scheduleLegacyRemoteClipboardFileCleanup()
    await vi.advanceTimersByTimeAsync(29_999)

    expect(cleanupLegacyRemoteClipboardStagingMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)

    expect(cleanupLegacyRemoteClipboardStagingMock).toHaveBeenCalledOnce()
    expect(cleanupLegacyRemoteClipboardStagingMock).toHaveBeenCalledWith('/tmp', 1_760_000_000_000)
  })
})
