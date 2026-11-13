import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type {
  BrowserScreencastOptions,
  BrowserScreencastSession
} from '../../../browser/cdp/screencast/browser-screencast-stream-types'
import {
  createSinglePageBrowserCommandsHost,
  createStreamedGuest
} from '../client-pages/single-page-browser-commands-host-test-double'
import { RuntimeBrowserCommands } from '../commands/browser-commands'

const { webContentsFromId, startBrowserScreencast } = vi.hoisted(() => ({
  webContentsFromId: vi.fn(),
  startBrowserScreencast:
    vi.fn<
      (guest: WebContents, options: BrowserScreencastOptions) => Promise<BrowserScreencastSession>
    >()
}))

vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: webContentsFromId }
}))
vi.mock('../../../browser/cdp/screencast/browser-screencast-stream', () => ({
  startBrowserScreencast
}))

function createSession() {
  let close!: () => void
  const done = new Promise<void>((resolve) => {
    close = resolve
  })
  return {
    stop: vi.fn(() => close()),
    done,
    updateViewport: async () => {},
    updateFrameBudget: async () => {}
  }
}

const params = { page: 'page-1', format: 'jpeg' } as const

describe('screencast ownership', () => {
  beforeEach(() => {
    webContentsFromId.mockReset()
    webContentsFromId.mockReturnValue(createStreamedGuest())
    startBrowserScreencast.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each(['older', 'newer'])(
    'keeps the newer viewer when the %s reconnect finishes first',
    async (firstReady) => {
      const session = createSession()
      let finishUpdate = (): void => {}
      let updateStarted = (): void => {}
      const started = new Promise<void>((resolve) => {
        updateStarted = resolve
      })
      vi.spyOn(session, 'updateFrameBudget').mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishUpdate = resolve
            updateStarted()
          })
      )
      startBrowserScreencast.mockResolvedValue(session)
      const commands = new RuntimeBrowserCommands(createSinglePageBrowserCommandsHost())
      const device = { pairedDeviceId: 'phone-1' }
      const first = await commands.browserScreencast(params, { ...device, sendBinary: () => true })
      const olderSend = vi.fn(() => true)
      const newerSend = vi.fn(() => true)
      const reconnectParams = { ...params, maxWidth: 640 }
      const olderJoin = commands.browserScreencast(reconnectParams, {
        ...device,
        sendBinary: olderSend
      })
      let finishViewport = (): void => {}
      let viewportStarted = (): void => {}
      const viewportPending = new Promise<void>((resolve) => {
        viewportStarted = resolve
      })
      if (firstReady === 'older') {
        vi.spyOn(session, 'updateViewport').mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              finishViewport = resolve
              viewportStarted()
            })
        )
      }

      try {
        await started
        const newerJoin = commands.browserScreencast(
          {
            ...reconnectParams,
            ...(firstReady === 'older' ? { viewportWidth: 640, viewportHeight: 480 } : {})
          },
          {
            ...device,
            sendBinary: newerSend
          }
        )
        if (firstReady === 'older') {
          await viewportPending
          finishUpdate()
          await olderJoin
          finishViewport()
        }
        const newer = await newerJoin
        await first.session.done
        finishUpdate()
        const older = await olderJoin
        await older.session.done
        const frame = new Uint8Array([1, 2, 3])
        startBrowserScreencast.mock.calls[0]?.[1].onFrame(frame)
        expect(olderSend).not.toHaveBeenCalled()
        expect(newerSend).toHaveBeenCalledWith(frame, { dropWhenBacklogged: true })
        expect(session.stop).not.toHaveBeenCalled()
        newer.session.stop()
        await newer.session.done
        expect(session.stop).toHaveBeenCalledOnce()
      } finally {
        finishUpdate()
        finishViewport()
        session.stop()
        await session.done
      }
    }
  )
})
