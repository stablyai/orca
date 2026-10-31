// Preserve mouse encoding with tracking, or ConPTY may deliver legacy wheel reports as typed input.
import './xterm-env-polyfill'
import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { HeadlessEmulator } from './headless-emulator'
import { serializeWithAbsoluteCursor } from '../../shared/terminal-serialize-absolute-cursor'
import { readTerminalMouseEncoding } from '../../shared/terminal-mouse-encoding'

const CODEX_FULLSCREEN_MODES = '\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h'
const SGR_WHEEL_UP_AT_10_5 = '\x1b[<64;10;5M'

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

type XtermCoreMouseEvent = {
  col: number
  row: number
  x: number
  y: number
  button: number
  action: number
}

type XtermMouseStateService = {
  areMouseEventsActive: boolean
  encodeMouseEvent: (event: XtermCoreMouseEvent) => string
}

function isXtermMouseStateService(value: unknown): value is XtermMouseStateService {
  return (
    typeof value === 'object' &&
    value !== null &&
    'areMouseEventsActive' in value &&
    typeof value.areMouseEventsActive === 'boolean' &&
    'encodeMouseEvent' in value &&
    typeof value.encodeMouseEvent === 'function'
  )
}

function wheelUpReport(terminal: Terminal): string | null {
  const core = '_core' in terminal ? terminal._core : undefined
  const service =
    typeof core === 'object' && core !== null && 'mouseStateService' in core
      ? core.mouseStateService
      : undefined
  if (!isXtermMouseStateService(service)) {
    throw new Error('xterm mouse state service is unavailable')
  }
  if (!service.areMouseEventsActive) {
    return null
  }
  return service.encodeMouseEvent({ col: 10, row: 5, x: 0, y: 0, button: 4, action: 0 })
}

describe('snapshot mouse encoding', () => {
  it('round-trips SGR encoding with the tracking mode, so the restore reports SGR', async () => {
    const { terminal, addon } = createTerminal()
    await write(terminal, `shell$ ${CODEX_FULLSCREEN_MODES}codex`)

    const restored = await replay(serializeWithAbsoluteCursor(addon, terminal))

    expect(restored.buffer.active.type).toBe('alternate')
    expect(restored.modes.mouseTrackingMode).toBe('any')
    expect(readTerminalMouseEncoding(restored)).toBe('sgr')
    expect(wheelUpReport(restored)).toBe(SGR_WHEEL_UP_AT_10_5)
  })

  it('round-trips SGR-pixels encoding', async () => {
    const { terminal, addon } = createTerminal()
    await write(terminal, 'x\x1b[?1002h\x1b[?1016h')

    const restored = await replay(serializeWithAbsoluteCursor(addon, terminal))

    expect(restored.modes.mouseTrackingMode).toBe('drag')
    expect(readTerminalMouseEncoding(restored)).toBe('sgr-pixels')
  })

  it('restores no mouse reports when tracking is off, even with SGR encoding armed', async () => {
    const { terminal, addon } = createTerminal()
    await write(terminal, 'x\x1b[?1003h\x1b[?1006h\x1b[?1003l')

    const restored = await replay(serializeWithAbsoluteCursor(addon, terminal))

    expect(restored.modes.mouseTrackingMode).toBe('none')
    expect(wheelUpReport(restored)).toBeNull()
  })

  it('carries the encoding from a renderer snapshot through a headless seed to its snapshot', async () => {
    // Mobile replay discards bytes before the last alternate-screen entry; encoding must survive that slice.
    const { terminal, addon } = createTerminal()
    await write(terminal, `shell$ ${CODEX_FULLSCREEN_MODES}codex`)
    const emulator = new HeadlessEmulator({ cols: 40, rows: 10 })
    await emulator.write(serializeWithAbsoluteCursor(addon, terminal))

    const snapshot = emulator.getSnapshot()
    const data = snapshot.rehydrateSequences + snapshot.snapshotAnsi
    const mobileReplay = data.slice(data.lastIndexOf('\x1b[?1049h'))

    expect(snapshot.modes.mouseTrackingMode).toBe('any')
    expect(snapshot.modes.sgrMouseMode).toBe(true)
    expect(mobileReplay).toContain('\x1b[?1003h')
    expect(mobileReplay).toContain('\x1b[?1006h')
    expect(wheelUpReport(await replay(data))).toBe(SGR_WHEEL_UP_AT_10_5)
    emulator.dispose()
  })
})
