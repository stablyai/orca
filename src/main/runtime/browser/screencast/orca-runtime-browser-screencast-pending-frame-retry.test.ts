import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SCREENCAST_PENDING_FRAME_RETRY_MS } from './browser-screencast-subscriber-frame-delivery'
import {
  createSinglePageBrowserCommandsHost,
  createStreamedGuest
} from '../client-pages/single-page-browser-commands-host-test-double'
import type { RpcBinarySender } from '../../rpc/transports/rpc-binary-sender'

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

async function subscribe(sendBinary: RpcBinarySender) {
  const { RuntimeBrowserCommands } = await import('../commands/browser-commands')
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
    webContentsFromId.mockReturnValue(createStreamedGuest())
    startBrowserScreencast.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // Idle pages produce no next frame; retry the latest refused frame after socket drain.
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
})
