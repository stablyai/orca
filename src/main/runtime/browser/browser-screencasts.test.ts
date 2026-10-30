import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each(['phone-1', 'phone-2'])(
    'removes a failed %s joiner while preserving the surviving stream',
    async (pairedDeviceId) => {
      vi.useFakeTimers()
      const session = createSession()
      const updateFrameBudget = vi
        .spyOn(session, 'updateFrameBudget')
        .mockRejectedValueOnce(new Error('screencast restart failed'))
      const updateViewport = vi.spyOn(session, 'updateViewport')
      startBrowserScreencast.mockResolvedValue(session)
      const commands = new RuntimeBrowserCommands(createSinglePageBrowserCommandsHost())
      const survivingSend = vi.fn(() => true)
      const failedSend = vi.fn(() => false)
      const first = await commands.browserScreencast(
        { ...params, viewportWidth: 1200, viewportHeight: 800 },
        { sendBinary: survivingSend, pairedDeviceId: 'phone-1' }
      )

      try {
        await expect(
          commands.browserScreencast(
            { ...params, maxWidth: 640, viewportWidth: 640, viewportHeight: 480 },
            { sendBinary: failedSend, pairedDeviceId }
          )
        ).rejects.toThrow('screencast restart failed')
        expect(updateFrameBudget).toHaveBeenCalled()
        expect(updateViewport).toHaveBeenLastCalledWith(
          expect.objectContaining({ viewportWidth: 1200, viewportHeight: 800 })
        )

        const frame = new Uint8Array([1, 2, 3])
        startBrowserScreencast.mock.calls[0]?.[1].onFrame(frame)
        await vi.advanceTimersByTimeAsync(100)
        expect(survivingSend).toHaveBeenCalledWith(frame, { dropWhenBacklogged: true })
        expect(failedSend).not.toHaveBeenCalled()
        expect(session.stop).not.toHaveBeenCalled()

        first.session.stop()
        await first.session.done
        expect(session.stop).toHaveBeenCalledOnce()
      } finally {
        session.stop()
        await session.done
        await vi.runAllTimersAsync()
      }
    }
  )

  it('stops a failed last joiner and permits a fresh native stream', async () => {
    const session = createSession()
    const replacementSession = createSession()
    let rejectUpdate = (_error: Error): void => {}
    let updateStarted = (): void => {}
    const started = new Promise<void>((resolve) => {
      updateStarted = resolve
    })
    vi.spyOn(session, 'updateFrameBudget').mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectUpdate = reject
          updateStarted()
        })
    )
    startBrowserScreencast.mockResolvedValueOnce(session).mockResolvedValueOnce(replacementSession)
    const guest = createStreamedGuest()
    webContentsFromId.mockReturnValue(guest)
    const commands = new RuntimeBrowserCommands(createSinglePageBrowserCommandsHost())
    const first = await commands.browserScreencast(params, { sendBinary: () => true })
    const joining = commands.browserScreencast(
      { ...params, maxWidth: 640 },
      { sendBinary: () => false }
    )
    const rejected = expect(joining).rejects.toThrow('screencast restart failed')

    try {
      await started
      first.session.stop()
      await first.session.done
      expect(session.stop).not.toHaveBeenCalled()
      rejectUpdate(new Error('screencast restart failed'))
      await rejected
      expect(session.stop).toHaveBeenCalledOnce()
      await session.done
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(vi.mocked(guest.setBackgroundThrottling).mock.calls).toEqual([[false], [true]])

      const replacement = await commands.browserScreencast(params, { sendBinary: () => true })
      expect(startBrowserScreencast).toHaveBeenCalledTimes(2)
      replacement.session.stop()
      await replacement.session.done
    } finally {
      session.stop()
      replacementSession.stop()
      await Promise.all([session.done, replacementSession.done])
    }
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
