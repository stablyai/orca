// Preserve mouse encoding with tracking, or ConPTY may deliver legacy wheel reports as typed input.
import '../xterm-env-polyfill'
import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { HeadlessEmulator } from '../headless-emulator'
import { serializeWithAbsoluteCursor } from '../../../../shared/terminal/replay/terminal-serialize-absolute-cursor'
import { readTerminalMouseEncoding } from '../../../../shared/terminal/protocol/input-modes/terminal-mouse-encoding'

const CODEX_FULLSCREEN_MODES = '\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h'

function createTerminal(): { terminal: Terminal; addon: SerializeAddon } {
  const terminal = new Terminal({ cols: 40, rows: 10, scrollback: 100, allowProposedApi: true })
  const addon = new SerializeAddon()
  terminal.loadAddon(addon)
  return { terminal, addon }
}

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, () => resolve()))
}

async function replay(data: string): Promise<Terminal> {
  const { terminal } = createTerminal()
  await write(terminal, data)
  return terminal
}

describe('snapshot mouse encoding', () => {
  it('restores tracking as off, even with SGR encoding armed', async () => {
    const { terminal, addon } = createTerminal()
    await write(terminal, 'x\x1b[?1003h\x1b[?1006h\x1b[?1003l')

    const restored = await replay(serializeWithAbsoluteCursor(addon, terminal))

    expect(restored.modes.mouseTrackingMode).toBe('none')
  })

  it('carries the encoding from a renderer snapshot through a headless seed to its snapshot', async () => {
    // Mobile replay discards bytes before the last alternate-screen entry; encoding must survive that slice.
    const { terminal, addon } = createTerminal()
    await write(terminal, `shell$ ${CODEX_FULLSCREEN_MODES}codex`)
    const emulator = new HeadlessEmulator({ cols: 40, rows: 10 })
    await emulator.write(serializeWithAbsoluteCursor(addon, terminal))

    const snapshot = emulator.getSnapshot()
    const data = snapshot.rehydrateSequences + snapshot.snapshotAnsi
    const restored = await replay(data.slice(data.lastIndexOf('\x1b[?1049h')))

    expect(restored.buffer.active.type).toBe('alternate')
    expect(restored.modes.mouseTrackingMode).toBe('any')
    expect(readTerminalMouseEncoding(restored)).toBe('sgr')
    emulator.dispose()
  })
})
