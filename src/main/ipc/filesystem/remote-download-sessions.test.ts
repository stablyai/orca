import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => unknown) => {
      handlers.set(channel, handler)
    }
  }
}))

import {
  beginRemoteDownloadSession,
  REMOTE_DOWNLOAD_PROGRESS_CHANNEL,
  registerRemoteDownloadCancelHandler
} from './remote-download-sessions'

function createSender(id: number) {
  return { id, isDestroyed: vi.fn(() => false), send: vi.fn() }
}

function cancel(sender: ReturnType<typeof createSender>, downloadId: string) {
  return handlers.get('fs:cancelDownload')!({ sender }, { downloadId })
}

describe('remote download sessions', () => {
  beforeEach(() => {
    handlers.clear()
    registerRemoteDownloadCancelHandler()
  })

  it('returns no session when the renderer did not ask for progress', () => {
    const sender = createSender(1)
    expect(beginRemoteDownloadSession(sender, undefined, 10)).toBeNull()
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('announces the start and forwards progress to the owning window', () => {
    const sender = createSender(1)
    const session = beginRemoteDownloadSession(sender, 'd1', 10)!
    expect(sender.send).toHaveBeenCalledWith(REMOTE_DOWNLOAD_PROGRESS_CHANNEL, {
      downloadId: 'd1',
      transferredBytes: 0,
      totalBytes: 10,
      completedFiles: 0
    })

    session.observer.onBytesTransferred?.(4)
    session.end()
    expect(sender.send).toHaveBeenLastCalledWith(
      REMOTE_DOWNLOAD_PROGRESS_CHANNEL,
      expect.objectContaining({ transferredBytes: 4 })
    )
  })

  it('does not send progress to a destroyed window', () => {
    const sender = createSender(1)
    sender.isDestroyed.mockReturnValue(true)
    const session = beginRemoteDownloadSession(sender, 'd1', 10)
    session?.end()
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('aborts only the matching download from the window that started it', () => {
    const owner = createSender(1)
    const other = createSender(2)
    const session = beginRemoteDownloadSession(owner, 'd1', 10)!

    expect(cancel(other, 'd1')).toEqual({ ok: true, canceled: false })
    expect(session.observer.signal?.aborted).toBe(false)

    expect(cancel(owner, 'd1')).toEqual({ ok: true, canceled: true })
    expect(session.observer.signal?.aborted).toBe(true)
    session.end()
  })

  it('forgets a download once it ends so its id can be reused', () => {
    const sender = createSender(1)
    const first = beginRemoteDownloadSession(sender, 'd1', 10)!
    expect(() => beginRemoteDownloadSession(sender, 'd1', 10)).toThrow(
      'Download is already running'
    )
    first.end()

    expect(cancel(sender, 'd1')).toEqual({ ok: true, canceled: false })
    const second = beginRemoteDownloadSession(sender, 'd1', 10)
    expect(second).not.toBeNull()
    second?.end()
  })
})
