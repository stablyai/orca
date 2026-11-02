import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type {
  BrowserScreencastOptions,
  BrowserScreencastSession
} from '../../browser/browser-screencast-stream-types'
import {
  createSinglePageBrowserCommandsHost,
  createStreamedGuest
} from '../single-page-browser-commands-host-test-double'
import { RuntimeBrowserCommands } from './browser-commands'

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
vi.mock('../../browser/browser-screencast-stream', () => ({ startBrowserScreencast }))

function createSession() {
  let close!: () => void
  const done = new Promise<void>((resolve) => {
    close = resolve
  })
  return {
    stop: vi.fn(() => close()),
    done,
    updateViewport: async () => {},
    updateFrameBudget: async () => {},
    settleDialog: async () => false
  }
}

const params = { page: 'page-1', format: 'jpeg' } as const

describe('screencast ownership', () => {
  beforeEach(() => {
    webContentsFromId.mockReset()
    webContentsFromId.mockReturnValue(createStreamedGuest())
    startBrowserScreencast.mockReset()
  })

  it('keeps same-page streams isolated between runtime instances', async () => {
    const firstSession = createSession()
    const secondSession = createSession()
    startBrowserScreencast.mockResolvedValueOnce(firstSession).mockResolvedValueOnce(secondSession)
    const firstCommands = new RuntimeBrowserCommands(createSinglePageBrowserCommandsHost())
    const secondCommands = new RuntimeBrowserCommands(createSinglePageBrowserCommandsHost())
    const firstSend = vi.fn(() => true)
    const secondSend = vi.fn(() => true)
    const first = await firstCommands.browserScreencast(params, { sendBinary: firstSend })
    const second = await secondCommands.browserScreencast(params, { sendBinary: secondSend })
    const frame = new Uint8Array([1, 2, 3])

    expect(startBrowserScreencast).toHaveBeenCalledTimes(2)
    startBrowserScreencast.mock.calls[0]?.[1].onFrame(frame)
    expect(firstSend).toHaveBeenCalledOnce()
    expect(secondSend).not.toHaveBeenCalled()

    first.session.stop()
    await first.session.done
    expect(firstSession.stop).toHaveBeenCalledOnce()
    expect(secondSession.stop).not.toHaveBeenCalled()
    startBrowserScreencast.mock.calls[1]?.[1].onFrame(frame)
    expect(secondSend).toHaveBeenCalledOnce()
    second.session.stop()
    await second.session.done
  })

  it('settles dialogs through the stream owned by the command instance', async () => {
    const session = createSession()
    const settleDialog = vi.spyOn(session, 'settleDialog').mockResolvedValue(true)
    startBrowserScreencast.mockResolvedValue(session)
    const commands = new RuntimeBrowserCommands(createSinglePageBrowserCommandsHost())
    const stream = await commands.browserScreencast(params, { sendBinary: () => true })

    expect(await commands.browserDialogAccept({ page: params.page, text: 'Ada' })).toEqual({
      accepted: true
    })
    expect(settleDialog).toHaveBeenCalledWith(true, 'Ada')
    expect(await commands.browserDialogDismiss({ page: params.page })).toEqual({ accepted: false })
    expect(settleDialog).toHaveBeenLastCalledWith(false, undefined)
    stream.session.stop()
    await stream.session.done
  })

  it('accepts startup callbacks before the stream promise is returned', async () => {
    const session = createSession()
    const startupFrame = new Uint8Array([4, 5, 6])
    const send = vi.fn(() => true)
    startBrowserScreencast.mockImplementation((_guest, options) => {
      expect(options.onFrame(startupFrame)).toBe(true)
      options.onError?.('startup notification')
      expect(send).not.toHaveBeenCalled()
      return Promise.resolve(session)
    })
    const commands = new RuntimeBrowserCommands(createSinglePageBrowserCommandsHost())
    const stream = await commands.browserScreencast(params, { sendBinary: send })

    expect(session.stop).not.toHaveBeenCalled()
    startBrowserScreencast.mock.calls[0]?.[1].onFrame(startupFrame)
    expect(send).toHaveBeenCalledWith(startupFrame, { dropWhenBacklogged: true })
    stream.session.stop()
    await stream.session.done
  })
})
