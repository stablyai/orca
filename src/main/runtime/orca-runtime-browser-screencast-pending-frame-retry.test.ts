import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BROWSER_SCREENCAST_GHOST_SUBSCRIBER_REFUSAL_LIMIT } from './browser-screencast-ghost-subscriber-eviction'
import { SCREENCAST_PENDING_FRAME_RETRY_MS } from './browser-screencast-subscriber-frame-delivery'
import { createSinglePageBrowserCommandsHost } from './single-page-browser-commands-host-test-double'
import type { RpcBinarySender } from './rpc/rpc-binary-sender'

const { webContentsFromId, startBrowserScreencast } = vi.hoisted(() => ({
  webContentsFromId: vi.fn(),
  startBrowserScreencast: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: webContentsFromId }
}))
vi.mock('../browser/browser-screencast-stream', () => ({ startBrowserScreencast }))

async function subscribe(sendBinary: RpcBinarySender) {
  const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
  let resolveDone!: () => void
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  const stop = vi.fn(() => resolveDone())
  startBrowserScreencast.mockResolvedValue({
    stop,
    done,
    updateViewport: vi.fn(async () => {})
  })
  const commands = new RuntimeBrowserCommands(createSinglePageBrowserCommandsHost())
  const subscription = await commands.browserScreencast(
    { worktree: 'id:wt-1', page: 'page-1', format: 'jpeg' },
    { sendBinary }
  )
  const onFrame: (bytes: Uint8Array<ArrayBufferLike>) => unknown =
    startBrowserScreencast.mock.calls[0][1].onFrame
  return { subscription, onFrame, stop }
}

describe('screencast frames a viewer refused', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    webContentsFromId.mockReset()
    webContentsFromId.mockReturnValue({ isDestroyed: () => false })
    startBrowserScreencast.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // Why: an idle page sends no next frame, so a refused last frame must reach the viewer once its
  // socket drains, or a relayed phone (whose server leg drops on a full socket) keeps a stale page.
  it('delivers the last refused frame once the socket drains, with no new frame produced', async () => {
    let socketFull = true
    const received: Uint8Array<ArrayBufferLike>[] = []
    const { subscription, onFrame } = await subscribe((bytes) => {
      if (socketFull) {
        return false
      }
      received.push(bytes)
      return true
    })
    const first = new Uint8Array([1])
    const last = new Uint8Array([2])
    onFrame(first)
    onFrame(last)
    await vi.advanceTimersByTimeAsync(SCREENCAST_PENDING_FRAME_RETRY_MS * 4)
    expect(received).toEqual([])

    socketFull = false
    await vi.advanceTimersByTimeAsync(SCREENCAST_PENDING_FRAME_RETRY_MS)
    expect(received).toEqual([last])
    await vi.advanceTimersByTimeAsync(SCREENCAST_PENDING_FRAME_RETRY_MS * 4)
    expect(received).toEqual([last])
    subscription.session.stop()
  })

  it('retries the newest refused frame when a newer one is refused mid-retry', async () => {
    let socketFull = true
    const received: Uint8Array<ArrayBufferLike>[] = []
    const { subscription, onFrame } = await subscribe((bytes) => {
      if (socketFull) {
        return false
      }
      received.push(bytes)
      return true
    })
    const stale = new Uint8Array([1])
    const newest = new Uint8Array([2])
    onFrame(stale)
    await vi.advanceTimersByTimeAsync(SCREENCAST_PENDING_FRAME_RETRY_MS * 2)
    onFrame(newest)
    socketFull = false
    await vi.advanceTimersByTimeAsync(SCREENCAST_PENDING_FRAME_RETRY_MS * 4)
    expect(received).toEqual([newest])
    subscription.session.stop()
  })

  // Why: a lossy frame must not queue behind a backlog; the retry above delivers the newest instead.
  it('asks the transport to drop frames while the socket is backlogged', async () => {
    const sendBinary = vi.fn(() => true)
    const { subscription, onFrame } = await subscribe(sendBinary)
    onFrame(new Uint8Array([1]))
    expect(sendBinary).toHaveBeenCalledWith(new Uint8Array([1]), { dropWhenBacklogged: true })
    subscription.session.stop()
  })

  it('stops retrying once the viewer leaves', async () => {
    const sendBinary = vi.fn(() => false)
    const { subscription, onFrame } = await subscribe(sendBinary)
    onFrame(new Uint8Array([1]))
    subscription.session.stop()
    await subscription.session.done
    sendBinary.mockClear()
    await vi.advanceTimersByTimeAsync(SCREENCAST_PENDING_FRAME_RETRY_MS * 4)
    expect(sendBinary).not.toHaveBeenCalled()
  })

  it('does not count refused retries toward ghost eviction', async () => {
    let refusing = false
    const { subscription, onFrame, stop } = await subscribe(() => !refusing)
    onFrame(new Uint8Array([0]))
    refusing = true
    onFrame(new Uint8Array([1]))
    await vi.advanceTimersByTimeAsync(
      SCREENCAST_PENDING_FRAME_RETRY_MS * BROWSER_SCREENCAST_GHOST_SUBSCRIBER_REFUSAL_LIMIT * 2
    )
    // Eviction is judged when a frame is produced.
    onFrame(new Uint8Array([2]))
    expect(stop).not.toHaveBeenCalled()
    subscription.session.stop()
  })
})
