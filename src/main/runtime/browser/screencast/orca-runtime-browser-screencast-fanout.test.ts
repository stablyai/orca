import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSinglePageBrowserCommandsHost,
  createStreamedGuest
} from '../client-pages/single-page-browser-commands-host-test-double'

const { webContentsFromId, startBrowserScreencast } = vi.hoisted(() => ({
  webContentsFromId: vi.fn(),
  startBrowserScreencast: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: webContentsFromId }
}))
vi.mock('../../../browser/cdp/screencast/browser-screencast-stream', () => ({
  startBrowserScreencast
}))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('RuntimeBrowserCommands screencast fanout', () => {
  beforeEach(() => {
    webContentsFromId.mockReset()
    webContentsFromId.mockReturnValue(createStreamedGuest())
    startBrowserScreencast.mockReset()
  })

  it('replays the joiner snapshot that its pre-ready gate refused', async () => {
    const { RuntimeBrowserCommands } = await import('../commands/browser-commands')
    const done = deferred()
    const snapshot = new Uint8Array([9, 9, 9])
    let onFrame: (bytes: Uint8Array<ArrayBufferLike>) => boolean | void = () => true
    // updateViewport emits before the joining viewer's ready gate opens.
    const updateViewport = vi.fn(async () => {
      onFrame(snapshot)
    })
    startBrowserScreencast.mockImplementation(async (_guest: unknown, options: never) => {
      onFrame = (options as { onFrame: typeof onFrame }).onFrame
      return {
        stop: vi.fn(() => done.resolve()),
        done: done.promise,
        updateViewport,
        updateFrameBudget: vi.fn(async () => {})
      }
    })
    const commands = new RuntimeBrowserCommands(createSinglePageBrowserCommandsHost())
    const creatorSend = vi.fn(() => true)
    await commands.browserScreencast(
      {
        worktree: 'id:wt-1',
        page: 'page-1',
        format: 'jpeg',
        viewportWidth: 1200,
        viewportHeight: 800
      },
      { sendBinary: creatorSend }
    )
    let gateOpen = false
    const joinerSend = vi.fn(() => gateOpen)
    const joiner = await commands.browserScreencast(
      {
        worktree: 'id:wt-1',
        page: 'page-1',
        format: 'jpeg',
        viewportWidth: 800,
        viewportHeight: 600
      },
      { sendBinary: joinerSend }
    )

    expect(creatorSend).toHaveBeenCalledWith(snapshot, { dropWhenBacklogged: true })
    expect(joinerSend).toHaveBeenCalledWith(snapshot, { dropWhenBacklogged: true })
    joinerSend.mockClear()
    gateOpen = true
    joiner.flushPendingFrame()
    expect(joinerSend).toHaveBeenCalledExactlyOnceWith(snapshot, { dropWhenBacklogged: true })

    joinerSend.mockClear()
    joiner.flushPendingFrame()
    expect(joinerSend).not.toHaveBeenCalled()
    joiner.session.stop()
    await joiner.session.done
  })
})
