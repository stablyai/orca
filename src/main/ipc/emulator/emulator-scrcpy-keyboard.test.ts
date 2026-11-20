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

import { scrcpyVideoRegistry } from '../../emulator/scrcpy-video-registry'
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

  it('pastes text scrcpy cannot type through the device clipboard, and types US text as before', () => {
    const decode = (message: Buffer) => ({
      type: message.readUInt8(0),
      text: message.subarray(message.readUInt8(0) === 9 ? 14 : 5).toString('utf8')
    })

    expect(sendKeyboard({ deviceId: 'serial-1', text: 'a;' })).toBe(true)
    // Turkish ş and Chinese have no virtual-keyboard key, so INJECT_TEXT would drop them.
    expect(sendKeyboard({ deviceId: 'serial-1', text: 'ş' })).toBe(true)
    expect(sendKeyboard({ deviceId: 'serial-1', text: 'Grüße\n中文', paste: true })).toBe(true)

    expect(sendControl.mock.calls.map(([message]) => decode(message))).toEqual([
      { type: 1, text: 'a;' }, // INJECT_TEXT
      { type: 9, text: 'ş' }, // SET_CLIPBOARD with paste
      { type: 9, text: 'Grüße\n中文' }
    ])
    const paste = sendControl.mock.calls[1][0]
    expect(paste.readBigUInt64BE(1)).toBe(0n) // no clipboard acknowledgement requested
    expect(paste.readUInt8(9)).toBe(1) // paste after setting the clipboard
    expect(paste.readUInt32BE(10)).toBe(2) // UTF-8 bytes of ş
  })
})
