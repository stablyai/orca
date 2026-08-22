import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { decodeBrowserScreencastFrame } from '../../shared/browser-screencast-protocol'
import { startBrowserScreencast } from './browser-screencast-stream'

function createMockWebContents() {
  let attached = false
  const dbg = new EventEmitter() as EventEmitter & {
    isAttached: ReturnType<typeof vi.fn>
    attach: ReturnType<typeof vi.fn>
    detach: ReturnType<typeof vi.fn>
    sendCommand: ReturnType<typeof vi.fn>
  }
  dbg.isAttached = vi.fn(() => attached)
  dbg.attach = vi.fn(() => {
    attached = true
  })
  dbg.detach = vi.fn(() => {
    attached = false
  })
  dbg.sendCommand = vi.fn(async () => ({}))
  return { isDestroyed: vi.fn(() => false), debugger: dbg }
}

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

function addHostCapture(webContents: ReturnType<typeof createMockWebContents>, image: Buffer) {
  Object.assign(webContents, {
    capturePage: vi.fn(async () => ({
      getSize: () => ({ width: 533, height: 917 }),
      resize: vi.fn(),
      toPNG: () => image,
      toJPEG: () => image
    }))
  })
}

function startPhysicalViewportScreencast(
  webContents: ReturnType<typeof createMockWebContents>,
  onFrame: (bytes: Uint8Array<ArrayBufferLike>) => void
) {
  return startBrowserScreencast(webContents as never, {
    format: 'jpeg',
    quality: 70,
    maxWidth: 3840,
    maxHeight: 2160,
    viewportWidth: 1097,
    viewportHeight: 917,
    deviceScaleFactor: 1,
    everyNthFrame: 2,
    minFrameIntervalMs: 0,
    onFrame
  })
}

describe('browser screencast host-surface fallback', () => {
  it('rejects a host-sized fallback capture when the client requested a wider viewport', async () => {
    const webContents = createMockWebContents()
    const hostCapture = jpegWithSize(533, 917)
    const clientCapture = jpegWithSize(1097, 917)
    addHostCapture(webContents, hostCapture)
    webContents.debugger.sendCommand.mockImplementation(async (method: string) => {
      if (method === 'Page.captureScreenshot') {
        return { data: clientCapture.toString('base64') }
      }
      return {}
    })
    const onFrame = vi.fn<(bytes: Uint8Array<ArrayBufferLike>) => void>()

    const session = await startPhysicalViewportScreencast(webContents, onFrame)

    await vi.waitFor(() => expect(onFrame).toHaveBeenCalledTimes(1))
    const frame = decodeBrowserScreencastFrame(onFrame.mock.calls[0][0])
    expect(frame?.metadata).toMatchObject({
      deviceWidth: 1097,
      deviceHeight: 917,
      imageWidth: 1097,
      imageHeight: 917
    })
    expect(webContents.debugger.sendCommand).toHaveBeenCalledWith(
      'Page.captureScreenshot',
      expect.any(Object)
    )

    session.stop()
    await session.done
  })

  it('does not publish a malformed fallback when both capture paths use the host surface', async () => {
    const webContents = createMockWebContents()
    const hostCapture = jpegWithSize(533, 917)
    addHostCapture(webContents, hostCapture)
    webContents.debugger.sendCommand.mockImplementation(async (method: string) => {
      if (method === 'Page.captureScreenshot') {
        return { data: hostCapture.toString('base64') }
      }
      return {}
    })
    const onFrame = vi.fn<(bytes: Uint8Array<ArrayBufferLike>) => void>()

    const session = await startPhysicalViewportScreencast(webContents, onFrame)

    await vi.waitFor(() =>
      expect(webContents.debugger.sendCommand).toHaveBeenCalledWith(
        'Page.captureScreenshot',
        expect.any(Object)
      )
    )
    expect(onFrame).not.toHaveBeenCalled()

    session.stop()
    await session.done
  })

  it('does not publish non-image snapshot bytes with viewport-compatible metadata', async () => {
    const webContents = createMockWebContents()
    const invalidImage = Buffer.from('not-an-image')
    const capturePage = vi.fn(async () => ({
      getSize: () => ({ width: 1097, height: 917 }),
      resize: vi.fn(),
      toPNG: () => invalidImage,
      toJPEG: () => invalidImage
    }))
    Object.assign(webContents, {
      capturePage
    })
    const onFrame = vi.fn<(bytes: Uint8Array<ArrayBufferLike>) => void>()

    const session = await startPhysicalViewportScreencast(webContents, onFrame)
    await vi.waitFor(() => expect(capturePage).toHaveBeenCalled())

    expect(onFrame).not.toHaveBeenCalled()
    session.stop()
    await session.done
  })
})
