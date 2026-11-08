import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => unknown>(),
  fromWebContents: vi.fn((): unknown => ({}))
}))

vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: (channel: string) => ipc.handlers.delete(channel),
    handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
      ipc.handlers.set(channel, handler)
    }
  },
  BrowserWindow: { fromWebContents: ipc.fromWebContents }
}))

import { scrcpyVideoRegistry } from '../emulator/scrcpy-video-registry'
import { registerEmulatorScrcpyKeyboardHandler } from './emulator-scrcpy-keyboard'

const sendControl = vi.fn((_message: Buffer) => true)

function sendKeyboard(payload: unknown): unknown {
  return ipc.handlers.get('emulator:scrcpyKeyboard')!({ sender: {} }, payload)
}

beforeEach(() => {
  sendControl.mockClear()
  ipc.fromWebContents.mockReturnValue({})
  scrcpyVideoRegistry.register('serial-1', () => {})
  scrcpyVideoRegistry.attachControl('serial-1', {
    videoSize: () => ({ width: 600, height: 1280 }),
    sendControl
  })
  registerEmulatorScrcpyKeyboardHandler()
})

afterEach(() => {
  scrcpyVideoRegistry.stop('serial-1')
})

describe('emulator:scrcpyKeyboard', () => {
  it('returns false for malformed input, unknown devices or keys, and non-window senders', () => {
    for (const payload of [
      null,
      { deviceId: 'serial-1' },
      { deviceId: 7, text: 'hi' },
      { deviceId: 'serial-2', text: 'hi' },
      { deviceId: 'serial-1', key: 'not_a_key', shift: false }
    ]) {
      expect(sendKeyboard(payload)).toBe(false)
    }
    ipc.fromWebContents.mockReturnValue(null)
    expect(sendKeyboard({ deviceId: 'serial-1', text: 'hi' })).toBe(false)

    expect(sendControl).not.toHaveBeenCalled()
  })
})
