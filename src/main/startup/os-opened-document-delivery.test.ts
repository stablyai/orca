import { describe, expect, it, vi } from 'vitest'
import { OsOpenedDocumentState } from './os-opened-documents'

/** Keep queued paths until main proves renderer delivery; both consume/resolve failures and pre-mount pushes can lose ownership. */
describe('os-opened markdown delivery ownership', () => {
  it('keeps the batch when resolution rejects on the pull path', async () => {
    const state = new OsOpenedDocumentState()
    state.captureFilePaths(['/notes/a.md'])
    const resolve = vi.fn().mockRejectedValue(new Error('floating root unavailable'))

    // Model the IPC pull body.
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
    expect(state.consume()).toEqual(['/notes/a.md'])
  })

  it('holds the batch while the renderer listener is not yet attached', () => {
    const state = new OsOpenedDocumentState()
    const send = vi.fn()
    let listenerReady = false

    // Model the push readiness guard.
    const publish = (): void => {
      if (!listenerReady) {
        return
      }
      const filePaths = state.consume()
      if (filePaths.length > 0) {
        send(filePaths)
      }
    }

    // An existing window may lack its listener; consuming/pushing now would silently discard paths.
    state.captureFilePaths(['/notes/a.md'], publish)
    expect(send).not.toHaveBeenCalled()

    // Only the renderer pull proves its listener is ready.
    listenerReady = true
    state.captureFilePaths(['/notes/b.md'], publish)
    expect(send).toHaveBeenCalledExactlyOnceWith(['/notes/a.md', '/notes/b.md'])
    expect(state.consume()).toEqual([])
  })

  it('restores a batch the window could no longer receive', () => {
    const state = new OsOpenedDocumentState()
    state.captureFilePaths(['/notes/a.md'])
    const filePaths = state.consume()

    // Window died between consume and send.
    state.restore(filePaths)

    expect(state.consume()).toEqual(['/notes/a.md'])
  })
})
