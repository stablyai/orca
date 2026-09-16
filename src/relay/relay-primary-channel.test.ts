import { win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { nullDevicePath } from './relay-primary-channel'

describe('nullDevicePath', () => {
  it('names the POSIX null device off win32', () => {
    expect(nullDevicePath('linux')).toBe('/dev/null')
    expect(nullDevicePath('darwin')).toBe('/dev/null')
  })

  /**
   * The defect this pins: `openSync('NUL')` on Windows does NOT open the null device.
   * node runs the path through `toNamespacedPath`, which resolves it against cwd and
   * prefixes `\\?\` — and `\\?\` turns off DOS device-name mapping, so CreateFileW makes
   * a real file. v1.4.203's Windows installer shipped one at
   * `resources/relay/win32-x64/NUL` because of it.
   */
  it('uses a device path win32 cannot rewrite into a file in the relay cwd', () => {
    const path = nullDevicePath('win32')

    expect(path).toBe('\\\\.\\NUL')
    expect(win32.toNamespacedPath(path)).toBe(path)
    // Bare `NUL` never survives as a device name: it is resolved against cwd, and a
    // drive-letter cwd then also takes the `\\?\` prefix. Spelled absolute because off
    // Windows `resolve` finds no drive letter and stops before that second rewrite.
    expect(win32.toNamespacedPath('NUL')).not.toBe('NUL')
    expect(win32.toNamespacedPath(String.raw`C:\relay\NUL`)).toBe(String.raw`\\?\C:\relay\NUL`)
  })
})
