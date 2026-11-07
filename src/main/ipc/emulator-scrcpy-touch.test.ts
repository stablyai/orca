import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ipc = vi.hoisted(() => ({
  listeners: new Map<string, (event: unknown, payload: unknown) => void>(),
  fromWebContents: vi.fn((): unknown => ({}))
}))

vi.mock('electron', () => ({
  ipcMain: {
    removeAllListeners: (channel: string) => ipc.listeners.delete(channel),
    on: (channel: string, listener: (event: unknown, payload: unknown) => void) => {
      ipc.listeners.set(channel, listener)
    }
  },
  BrowserWindow: { fromWebContents: ipc.fromWebContents }
}))

import { scrcpyVideoRegistry } from '../emulator/scrcpy-video-registry'
import { registerEmulatorScrcpyTouchHandler } from './emulator-scrcpy-touch'

const sendControl = vi.fn((_message: Buffer) => true)

function sendTouch(payload: unknown): void {
  ipc.listeners.get('emulator:scrcpyTouch')!({ sender: {} }, payload)
}

beforeEach(() => {
  sendControl.mockClear()
  ipc.fromWebContents.mockReturnValue({})
  scrcpyVideoRegistry.register('serial-1', () => {})
  scrcpyVideoRegistry.attachControl('serial-1', {
    videoSize: () => ({ width: 600, height: 1280 }),
    sendControl
  })
  registerEmulatorScrcpyTouchHandler()
})

afterEach(() => {
  scrcpyVideoRegistry.stop('serial-1')
})

describe('emulator:scrcpyTouch', () => {
  it('injects each pointer phase into the live session in video pixels', () => {
    sendTouch({ deviceId: 'serial-1', type: 'begin', x: 0.5, y: 0.5 })
    sendTouch({ deviceId: 'serial-1', type: 'move', x: 0.5, y: 0.25 })
    sendTouch({ deviceId: 'serial-1', type: 'end', x: 0.5, y: 0.25 })

    expect(
      sendControl.mock.calls.map(([message]) => [
        message[1],
        message.readInt32BE(10),
        message.readInt32BE(14)
      ])
    ).toEqual([
      [0, 300, 640],
      [2, 300, 320],
      [1, 300, 320]
    ])
  })

  it('ignores malformed touches, unknown devices and non-window senders', () => {
    for (const payload of [
      null,
      { deviceId: 'serial-1', type: 'tap', x: 0.5, y: 0.5 },
      { deviceId: 'serial-1', type: 'begin', x: Number.NaN, y: 0.5 },
      { deviceId: 'serial-1', type: 'begin', x: 0.5, y: 1.5 },
      { deviceId: 7, type: 'begin', x: 0.5, y: 0.5 },
      { deviceId: 'serial-2', type: 'begin', x: 0.5, y: 0.5 }
    ]) {
      sendTouch(payload)
    }
    ipc.fromWebContents.mockReturnValue(null)
    sendTouch({ deviceId: 'serial-1', type: 'begin', x: 0.5, y: 0.5 })

    expect(sendControl).not.toHaveBeenCalled()
  })
})
