import { describe, expect, it, vi } from 'vitest'
import { OsOpenedMarkdownFileState } from './os-opened-markdown-files'

/**
 * The two ways a queued "Open With" can be lost between main and the renderer. Both are
 * about ownership: main must not drop paths it has not proven the renderer received.
 */
describe('os-opened markdown delivery ownership', () => {
  it('keeps the batch when resolution rejects on the pull path', async () => {
    const state = new OsOpenedMarkdownFileState()
    state.captureFilePaths(['/notes/a.md'])
    const resolve = vi.fn().mockRejectedValue(new Error('floating root unavailable'))

    // Mirrors the ipcMain.handle('ui:consumePendingMarkdownFileOpens') body.
    const pull = async (): Promise<unknown> => {
      const filePaths = state.consume()
      try {
        return await resolve(filePaths)
      } catch (error) {
        state.restore(filePaths)
        throw error
      }
    }

    await expect(pull()).rejects.toThrow('floating root unavailable')
    // Without the restore the file would be gone and no later mount could ever open it.
    expect(state.consume()).toEqual(['/notes/a.md'])
  })

  it('holds the batch while the renderer listener is not yet attached', () => {
    const state = new OsOpenedMarkdownFileState()
    const send = vi.fn()
    let listenerReady = false

    // Mirrors publishOsOpenedMarkdownFiles()'s guard.
    const publish = (): void => {
      if (!listenerReady) {
        return
      }
      const filePaths = state.consume()
      if (filePaths.length > 0) {
        send(filePaths)
      }
    }

    // A window exists, but the renderer has not mounted its bridge yet: send() here would be
    // dropped by Electron with no error, and consuming would destroy the queue.
    state.captureFilePaths(['/notes/a.md'], publish)
    expect(send).not.toHaveBeenCalled()

    // The renderer's pull is what proves the listener is live.
    listenerReady = true
    state.captureFilePaths(['/notes/b.md'], publish)
    expect(send).toHaveBeenCalledExactlyOnceWith(['/notes/a.md', '/notes/b.md'])
    expect(state.consume()).toEqual([])
  })

  it('restores a batch the window could no longer receive', () => {
    const state = new OsOpenedMarkdownFileState()
    state.captureFilePaths(['/notes/a.md'])
    const filePaths = state.consume()

    // Window died between consume and send.
    state.restore(filePaths)

    expect(state.consume()).toEqual(['/notes/a.md'])
  })
})
