import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  createFromBufferMock,
  fromWebContentsMock,
  handleMock,
  showSaveDialogMock,
  toPngMock,
  writeFileMock
} = vi.hoisted(() => ({
  createFromBufferMock: vi.fn(),
  fromWebContentsMock: vi.fn(),
  handleMock: vi.fn(),
  showSaveDialogMock: vi.fn(),
  toPngMock: vi.fn(),
  writeFileMock: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: fromWebContentsMock
  },
  dialog: {
    showSaveDialog: showSaveDialogMock
  },
  ipcMain: {
    handle: handleMock
  },
  nativeImage: {
    createFromBuffer: createFromBufferMock
  }
}))

vi.mock('node:fs/promises', () => ({
  writeFile: writeFileMock
}))

import {
  buildEmulatorScreenshotDefaultPath,
  encodeEmulatorScreenshotPng,
  registerEmulatorScreenshotHandlers
} from './emulator-screenshot'

describe('emulator screenshot IPC', () => {
  beforeEach(() => {
    createFromBufferMock.mockReset()
    fromWebContentsMock.mockReset()
    handleMock.mockReset()
    showSaveDialogMock.mockReset()
    toPngMock.mockReset()
    writeFileMock.mockReset()
    createFromBufferMock.mockReturnValue({
      isEmpty: () => false,
      toPNG: toPngMock
    })
    toPngMock.mockReturnValue(Buffer.from('png-bytes'))
  })

  it('builds a sanitized PNG default filename', () => {
    expect(
      buildEmulatorScreenshotDefaultPath(
        'iPhone 16 Pro / Debug',
        new Date('2026-06-11T20:31:04.123Z')
      )
    ).toBe('orca-iPhone-16-Pro-Debug-2026-06-11-20-31-04.png')
  })

  it('encodes the frame as PNG', () => {
    const input = new Uint8Array([1, 2, 3]).buffer

    expect(encodeEmulatorScreenshotPng(input)).toEqual(Buffer.from('png-bytes'))
    expect(createFromBufferMock).toHaveBeenCalledWith(Buffer.from([1, 2, 3]))
  })

  it('throws when the frame is not a valid image', () => {
    createFromBufferMock.mockReturnValue({
      isEmpty: () => true,
      toPNG: toPngMock
    })

    expect(() => encodeEmulatorScreenshotPng(new Uint8Array([1]).buffer)).toThrow(
      'Emulator screenshot frame is not a valid image.'
    )
  })

  it('writes the selected screenshot file', async () => {
    const parentWindow = { id: 1 }
    fromWebContentsMock.mockReturnValue(parentWindow)
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: '/tmp/sim.png' })
    registerEmulatorScreenshotHandlers()
    const handler = handleMock.mock.calls.find(
      ([channel]) => channel === 'emulator:saveScreenshot'
    )?.[1]

    await expect(
      handler({ sender: { id: 7 } }, { bytes: new Uint8Array([4, 5]).buffer, deviceName: 'Phone' })
    ).resolves.toEqual({ canceled: false, destinationPath: '/tmp/sim.png' })

    expect(showSaveDialogMock).toHaveBeenCalledWith(parentWindow, {
      defaultPath: expect.stringMatching(/^orca-Phone-/),
      filters: [{ name: 'PNG Image', extensions: ['png'] }]
    })
    expect(writeFileMock).toHaveBeenCalledWith('/tmp/sim.png', Buffer.from('png-bytes'))
  })

  it('does not write a file when the save dialog is canceled', async () => {
    showSaveDialogMock.mockResolvedValue({ canceled: true })
    registerEmulatorScreenshotHandlers()
    const handler = handleMock.mock.calls.find(
      ([channel]) => channel === 'emulator:saveScreenshot'
    )?.[1]

    await expect(
      handler({ sender: {} }, { bytes: new Uint8Array([4, 5]).buffer, deviceName: 'Phone' })
    ).resolves.toEqual({ canceled: true })

    expect(writeFileMock).not.toHaveBeenCalled()
  })
})
