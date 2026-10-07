import { Terminal } from '@xterm/xterm'
import { expect, it } from 'vitest'
import { HeadlessEmulator } from './headless-emulator'

for (const alternateScreen of [false, true]) {
  it(`preserves named placeholder IDs through an immediate ${alternateScreen ? 'alternate' : 'normal'} host snapshot`, async () => {
    const host = new HeadlessEmulator({ cols: 30, rows: 5 })
    const restored = new Terminal({ cols: 30, rows: 5, allowProposedApi: true })
    try {
      const prefix = alternateScreen ? '\x1b[?1049h' : ''
      expect(
        host.writeSync(
          `${prefix}\x1b[38;2;0;255;0m\x1b[58;2;0;0;10m\u{10EEEE}\u0305` +
            '\x1b[58;2;255;255;255m\u{10EEEE}\u030D' +
            '\x1b[59mX\x1b[58;2;0;0;99m'
        )
      ).toBe(true)
      const snapshot = host.getSnapshot()
      expect(snapshot.modes.alternateScreen).toBe(alternateScreen)
      await new Promise<void>((resolve) => restored.write(snapshot.snapshotAnsi, resolve))
      const line = restored.buffer.active.getLine(0)
      expect(line?.getCell(0)?.getChars()).toBe('\u{10EEEE}\u0305')
      expect(line?.getCell(0)?.getUnderlineColor()).toBe(10)
      expect(line?.getCell(1)?.getUnderlineColor()).toBe(0xffffff)
      expect(line?.getCell(2)?.getUnderlineColor()).toBe(0x00ff00)
      for (const col of [0, 1, 2]) {
        expect(line?.getCell(col)?.isUnderline()).toBeFalsy()
      }
      await new Promise<void>((resolve) => restored.write('\u{10EEEE}\u030E', resolve))
      expect(line?.getCell(3)?.getUnderlineColor()).toBe(99)
      expect(line?.getCell(3)?.isUnderline()).toBeFalsy()
    } finally {
      restored.dispose()
      host.dispose()
    }
  })
}
