import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'

import { decodeBrowserScreencastFrame } from '../../shared/browser-screencast-protocol'
import { clampScreencastViewportToGuestView } from './browser-screencast-guest-view-limit'
import { startBrowserScreencast } from './browser-screencast-stream'
import { createMockScreencastWebContents } from './browser-screencast-web-contents-test-double'

function jpegWithSize(width: number, height: number): Buffer {
  return Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x00,
    0x03,
    0x11,
    0x00,
    0xff,
    0xd9
  ])
}

function createGuest(type: 'webview' | 'window') {
  return Object.assign(createMockScreencastWebContents(), { getType: vi.fn(() => type) })
}

// Model a webview compositor constrained by its embedder.
function emitGuestFrame(
  guest: ReturnType<typeof createGuest>,
  sessionId: number,
  view: { width: number; height: number }
): void {
  guest.debugger.emit('message', {}, 'Page.screencastFrame', {
    data: jpegWithSize(view.width, view.height).toString('base64'),
    sessionId,
    metadata: { deviceWidth: view.width, deviceHeight: view.height }
  })
}

function emulatedSizes(guest: ReturnType<typeof createGuest>): string[] {
  const sizes = guest.debugger.sendCommand.mock.calls
    .filter(([method]) => method === 'Emulation.setDeviceMetricsOverride')
    .map(([, params]) => `${params.width}x${params.height}`)
  return sizes.filter((size, index) => size !== sizes[index - 1])
}

async function startOversizedStream(guest: ReturnType<typeof createGuest>, onFrame = vi.fn()) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the double implements every WebContents member the stream calls; the other screencast tests pass it the same way.
  return startBrowserScreencast(guest as never, {
    format: 'jpeg',
    quality: 70,
    maxWidth: 3840,
    maxHeight: 2160,
    viewportWidth: 1833,
    viewportHeight: 1179,
    deviceScaleFactor: 2,
    everyNthFrame: 1,
    minFrameIntervalMs: 0,
    onFrame
  })
}

describe('clampScreencastViewportToGuestView', () => {
  it('shrinks each side the guest cannot paint and keeps the rest of the request', () => {
    expect(
      clampScreencastViewportToGuestView(
        { viewportWidth: 1833, viewportHeight: 1179, deviceScaleFactor: 2, mobile: false },
        { width: 1463, height: 849 }
      )
    ).toEqual({ viewportWidth: 1463, viewportHeight: 849, deviceScaleFactor: 2, mobile: false })
    expect(
      clampScreencastViewportToGuestView(
        { viewportWidth: 390, viewportHeight: 900 },
        { width: 1463, height: 849 }
      )
    ).toEqual({ viewportWidth: 390, viewportHeight: 849 })
  })

  it('never goes below the smallest viewport a client may request', () => {
    expect(
      clampScreencastViewportToGuestView(
        { viewportWidth: 800, viewportHeight: 600 },
        { width: 1, height: 1 }
      )
    ).toEqual({ viewportWidth: 320, viewportHeight: 240 })
  })

  it('leaves a sizeless request alone', () => {
    expect(clampScreencastViewportToGuestView({}, { width: 600, height: 400 })).toEqual({})
  })
})

describe('screencast of a guest smaller than the requested viewport (#30341)', () => {
  it('re-emulates at the size the guest can paint and labels frames with it', async () => {
    const guest = createGuest('webview')
    const onFrame = vi.fn()
    const session = await startOversizedStream(guest, onFrame)
    await vi.waitFor(() =>
      expect(guest.debugger.sendCommand).toHaveBeenCalledWith(
        'Page.captureScreenshot',
        expect.anything()
      )
    )
    expect(emulatedSizes(guest)).toEqual(['1833x1179'])

    emitGuestFrame(guest, 1, { width: 1463, height: 849 })
    await vi.waitFor(() => expect(emulatedSizes(guest)).toEqual(['1833x1179', '1463x849']))
    expect(guest.debugger.sendCommand).toHaveBeenCalledWith('Page.screencastFrameAck', {
      sessionId: 1
    })
    expect(onFrame).not.toHaveBeenCalled()

    emitGuestFrame(guest, 2, { width: 1463, height: 849 })
    await vi.waitFor(() => expect(onFrame).toHaveBeenCalledTimes(1))
    expect(decodeBrowserScreencastFrame(onFrame.mock.calls[0][0])?.metadata).toMatchObject({
      deviceWidth: 1463,
      deviceHeight: 849
    })

    session.stop()
    await session.done
  })

  it('gives the requested size back once the guest grows, and follows a new request', async () => {
    const guest = createGuest('webview')
    const session = await startOversizedStream(guest)
    emitGuestFrame(guest, 1, { width: 1463, height: 849 })
    await vi.waitFor(() => expect(emulatedSizes(guest)).toHaveLength(2))

    emitGuestFrame(guest, 2, { width: 2000, height: 1300 })
    await vi.waitFor(() => expect(emulatedSizes(guest).at(-1)).toBe('1833x1179'))

    await session.updateViewport({ viewportWidth: 1028, viewportHeight: 1179 })
    expect(emulatedSizes(guest).at(-1)).toBe('1028x1179')

    emitGuestFrame(guest, 3, { width: 1463, height: 849 })
    await vi.waitFor(() => expect(emulatedSizes(guest).at(-1)).toBe('1028x849'))

    session.stop()
    await session.done
  })

  it('keeps dropping guest frames until the fitted size is actually emulated', async () => {
    const guest = createGuest('webview')
    let releaseSnapshot!: () => void
    const snapshotHeld = new Promise<void>((resolve) => {
      releaseSnapshot = resolve
    })
    guest.debugger.sendCommand.mockImplementation(async (method: string) => {
      if (method === 'Page.captureScreenshot') {
        await snapshotHeld
      }
      return {}
    })
    const onFrame = vi.fn()
    const session = await startOversizedStream(guest, onFrame)

    emitGuestFrame(guest, 1, { width: 1463, height: 849 })
    emitGuestFrame(guest, 2, { width: 1463, height: 849 })
    await vi.waitFor(() =>
      expect(guest.debugger.sendCommand).toHaveBeenCalledWith('Page.screencastFrameAck', {
        sessionId: 2
      })
    )
    expect(onFrame).not.toHaveBeenCalled()
    expect(emulatedSizes(guest)).toEqual(['1833x1179'])

    releaseSnapshot()
    await vi.waitFor(() => expect(emulatedSizes(guest)).toEqual(['1833x1179', '1463x849']))
    emitGuestFrame(guest, 3, { width: 1463, height: 849 })
    await vi.waitFor(() => expect(onFrame).toHaveBeenCalledTimes(1))

    session.stop()
    await session.done
  })

  it('resumes live frames once the fitted size is emulated, before its snapshot returns', async () => {
    const guest = createGuest('webview')
    let screenshots = 0
    guest.debugger.sendCommand.mockImplementation(async (method: string) => {
      if (method === 'Page.captureScreenshot') {
        screenshots += 1
        if (screenshots > 1) {
          await new Promise<void>(() => {})
        }
      }
      return {}
    })
    const onFrame = vi.fn()
    const session = await startOversizedStream(guest, onFrame)
    await vi.waitFor(() => expect(screenshots).toBe(1))

    emitGuestFrame(guest, 1, { width: 1463, height: 849 })
    await vi.waitFor(() => expect(screenshots).toBe(2))
    expect(emulatedSizes(guest)).toEqual(['1833x1179', '1463x849'])
    emitGuestFrame(guest, 2, { width: 1463, height: 849 })
    await vi.waitFor(() => expect(onFrame).toHaveBeenCalledTimes(1))

    session.stop()
  })

  it('keeps the full request for a window guest, which can grow to it', async () => {
    const guest = createGuest('window')
    const session = await startOversizedStream(guest)

    emitGuestFrame(guest, 1, { width: 1463, height: 849 })
    await vi.waitFor(() =>
      expect(guest.debugger.sendCommand).toHaveBeenCalledWith('Page.screencastFrameAck', {
        sessionId: 1
      })
    )
    expect(emulatedSizes(guest)).toEqual(['1833x1179'])

    session.stop()
    await session.done
  })
})
