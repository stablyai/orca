import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

import { decodeBrowserScreencastFrame } from '../../../../shared/browser/screencast/browser-screencast-protocol'
import { startBrowserScreencast } from './browser-screencast-stream'
import { installBrowserJavaScriptDialogs } from '../../guest-lifecycle/prompts/browser-javascript-dialogs'
import { createMockScreencastWebContents as createMockWebContents } from './browser-screencast-web-contents-test-double'

describe('startBrowserScreencast', () => {
  it('does not emit a stale navigation fallback capture after newer live frames', async () => {
    vi.useFakeTimers()
    const webContents = createMockWebContents()
    const pendingCaptures: ((value: { data: string }) => void)[] = []
    webContents.debugger.sendCommand.mockImplementation(async (method: string) => {
      if (method === 'Page.captureScreenshot') {
        return await new Promise<{ data: string }>((resolve) => pendingCaptures.push(resolve))
      }
      return {}
    })
    const onFrame = vi.fn()

    const session = await startBrowserScreencast(webContents as never, {
      format: 'jpeg',
      quality: 70,
      maxWidth: 1440,
      maxHeight: 1200,
      everyNthFrame: 1,
      minFrameIntervalMs: 0,
      onFrame
    })

    try {
      await Promise.resolve()
      webContents.debugger.emit('message', {}, 'Page.screencastFrame', {
        data: Buffer.from('first-live-frame').toString('base64'),
        sessionId: 42,
        metadata: { deviceWidth: 800, deviceHeight: 600 }
      })
      expect(onFrame).toHaveBeenCalledTimes(1)

      pendingCaptures[0]?.({ data: Buffer.from('stale-initial').toString('base64') })
      await Promise.resolve()
      await Promise.resolve()
      expect(onFrame).toHaveBeenCalledTimes(1)

      webContents.debugger.emit('message', {}, 'Page.loadEventFired', {})
      await vi.advanceTimersByTimeAsync(250)
      await Promise.resolve()
      expect(pendingCaptures).toHaveLength(2)

      webContents.debugger.emit('message', {}, 'Page.screencastFrame', {
        data: Buffer.from('newer-live-frame').toString('base64'),
        sessionId: 43,
        metadata: { deviceWidth: 800, deviceHeight: 600 }
      })
      pendingCaptures[1]?.({ data: Buffer.from('stale-navigation').toString('base64') })
      await Promise.resolve()
      await Promise.resolve()

      expect(onFrame).toHaveBeenCalledTimes(2)
      const secondFrame = decodeBrowserScreencastFrame(onFrame.mock.calls[1][0])
      expect(Buffer.from(secondFrame?.image ?? new Uint8Array()).toString()).toBe(
        'newer-live-frame'
      )
    } finally {
      session.stop()
      await session.done
      vi.useRealTimers()
    }
  })

  it('flushes the latest throttled live frame when the page becomes static', async () => {
    vi.useFakeTimers()
    const webContents = createMockWebContents()
    const onFrame = vi.fn()
    let now = 1000
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => now)

    const session = await startBrowserScreencast(webContents as never, {
      format: 'jpeg',
      quality: 70,
      maxWidth: 1440,
      maxHeight: 1200,
      everyNthFrame: 1,
      minFrameIntervalMs: 100,
      onFrame
    })

    try {
      webContents.debugger.emit('message', {}, 'Page.screencastFrame', {
        data: Buffer.from('before-menu').toString('base64'),
        sessionId: 42,
        metadata: { deviceWidth: 800, deviceHeight: 600 }
      })
      now = 1040
      webContents.debugger.emit('message', {}, 'Page.screencastFrame', {
        data: Buffer.from('menu-opening').toString('base64'),
        sessionId: 43,
        metadata: { deviceWidth: 800, deviceHeight: 600 }
      })
      now = 1060
      webContents.debugger.emit('message', {}, 'Page.screencastFrame', {
        data: Buffer.from('menu-open-final').toString('base64'),
        sessionId: 44,
        metadata: { deviceWidth: 800, deviceHeight: 600 }
      })

      expect(onFrame).toHaveBeenCalledTimes(1)
      now = 1100
      await vi.advanceTimersByTimeAsync(60)

      expect(onFrame).toHaveBeenCalledTimes(2)
      const frame = decodeBrowserScreencastFrame(onFrame.mock.calls[1][0])
      expect(Buffer.from(frame?.image ?? new Uint8Array()).toString()).toBe('menu-open-final')
    } finally {
      dateNow.mockRestore()
      session.stop()
      await session.done
      vi.useRealTimers()
    }
  })

  it('keeps the phone card on the dialog Orca holds, and dismisses it when the last viewer leaves', async () => {
    const webContents = Object.assign(new EventEmitter(), createMockWebContents(), {
      id: 501,
      getURL: () => 'https://example.com'
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dialog owner reads only id, URL and the emitter; the double carries all three.
    installBrowserJavaScriptDialogs(webContents as never, () => null)
    const onEvent = vi.fn()
    const session = await startBrowserScreencast(webContents as never, {
      format: 'jpeg',
      quality: 70,
      maxWidth: 1440,
      maxHeight: 1200,
      everyNthFrame: 2,
      minFrameIntervalMs: 0,
      onFrame: vi.fn(),
      onEvent
    })
    const answer = vi.fn()
    webContents.emit(
      '-run-dialog',
      { dialogType: 'confirm', messageText: 'Continue?', defaultPromptText: '' },
      answer
    )

    // The turned-away dialog's close names no dialog.
    webContents.debugger.emit('message', {}, 'Page.javascriptDialogClosed', {})

    expect(onEvent).toHaveBeenLastCalledWith({
      type: 'dialog',
      dialogType: 'confirm',
      message: 'Continue?'
    })
    // The last viewer leaving dismisses it, so a later session isn't blocked behind it.
    session.stop()
    await session.done
    expect(answer).toHaveBeenCalledExactlyOnceWith(false, '')
  })
})
