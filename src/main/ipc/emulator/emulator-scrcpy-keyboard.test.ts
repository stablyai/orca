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
  it('returns false for malformed input, unknown devices or keys, and non-window senders', async () => {
    for (const payload of [
      null,
      { deviceId: 'serial-1' },
      { deviceId: 7, text: 'hi' },
      { deviceId: 'serial-2', text: 'hi' },
      { deviceId: 'serial-1', key: 'not_a_key', shift: false }
    ]) {
      await expect(sendKeyboard(payload)).resolves.toBe(false)
    }
    ipc.fromWebContents.mockReturnValue(null)
    await expect(sendKeyboard({ deviceId: 'serial-1', text: 'hi' })).resolves.toBe(false)

    expect(sendControl).not.toHaveBeenCalled()
  })

  it('pastes text scrcpy cannot type through the clipboard, one paste at a time and in order', async () => {
    vi.useFakeTimers()
    const decode = (message: Buffer) => {
      const type = message.readUInt8(0)
      if (type === 0) {
        return { type, keycode: message.readInt32BE(2), action: message.readUInt8(1) }
      }
      return { type, text: message.subarray(type === 9 ? 14 : 5).toString('utf8') }
    }

    // Turkish ş and ğ have no virtual-keyboard key, so INJECT_TEXT would drop them; typed
    // back to back they join one paste, and the Backspace after them waits its turn.
    const typed = [
      sendKeyboard({ deviceId: 'serial-1', text: 'ş' }),
      sendKeyboard({ deviceId: 'serial-1', text: 'ğ' }),
      sendKeyboard({ deviceId: 'serial-1', key: 'backspace', shift: false }),
      sendKeyboard({ deviceId: 'serial-1', text: 'a;' }),
      sendKeyboard({ deviceId: 'serial-1', text: 'Grüße\n中文', paste: true }),
      sendKeyboard({ deviceId: 'serial-1', text: 'one\ntwo', paste: true })
    ]
    await vi.advanceTimersByTimeAsync(0)
    expect(sendControl).toHaveBeenCalledTimes(4)
    // The next clipboard write waits until the app has had time to read the last one.
    await vi.advanceTimersByTimeAsync(400)
    await expect(Promise.all(typed)).resolves.toEqual([true, true, true, true, true, true])

    expect(sendControl.mock.calls.map(([message]) => decode(message))).toEqual([
      { type: 9, text: 'şğ' }, // SET_CLIPBOARD with paste
      { type: 0, keycode: 67, action: 0 }, // KEYCODE_DEL down
      { type: 0, keycode: 67, action: 1 },
      { type: 1, text: 'a;' }, // US text stays INJECT_TEXT
      { type: 9, text: 'Grüße\n中文' },
      // A multi-line paste keeps its newlines as text instead of pressing Enter.
      { type: 9, text: 'one\ntwo' }
    ])
    const paste = sendControl.mock.calls[0][0]
    expect(paste.readBigUInt64BE(1)).toBe(0n) // no clipboard acknowledgement requested
    expect(paste.readUInt8(9)).toBe(1) // paste after setting the clipboard
    expect(paste.readUInt32BE(10)).toBe(4) // UTF-8 bytes of şğ
    vi.useRealTimers()
  })
})
