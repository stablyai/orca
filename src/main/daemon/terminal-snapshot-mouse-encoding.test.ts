// #23818: a restored pane must keep the mouse encoding (DECSET 1006/1016) with
// the tracking mode, or it reports wheel events as legacy `ESC [ M` bytes that a
// ConPTY host delivers to the app as typed text.
import './xterm-env-polyfill'
import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { HeadlessEmulator } from './headless-emulator'
import { serializeWithAbsoluteCursor } from '../../shared/terminal-serialize-absolute-cursor'
import { readTerminalMouseEncoding } from '../../shared/terminal-mouse-encoding'

const CODEX_FULLSCREEN_MODES = '\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h'
const X10_WHEEL_UP_AT_10_5 = `\x1b[M${String.fromCharCode(96, 42, 37)}`
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

/** xterm's private mouse state service: the encoder desktop viewers send reports through. */
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

/** The report xterm's own encoder sends for a wheel-up, or null when tracking is off. */
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
  it('the bare addon drops SGR encoding, so its restore reports X10 (the #23818 shape)', async () => {
    const { terminal, addon } = createTerminal()
    await write(terminal, `shell$ ${CODEX_FULLSCREEN_MODES}codex`)

    const restored = await replay(addon.serialize())

    expect(restored.modes.mouseTrackingMode).toBe('any')
    expect(wheelUpReport(restored)).toBe(X10_WHEEL_UP_AT_10_5)
  })

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

  it('adds nothing for the default encoding or when modes are excluded', async () => {
    const { terminal, addon } = createTerminal()
    await write(terminal, 'x\x1b[?1000h')
    const legacy = serializeWithAbsoluteCursor(addon, terminal)
    expect(legacy).toContain('\x1b[?1000h')
    expect(legacy).not.toContain('\x1b[?1006h')
    expect(legacy).not.toContain('\x1b[?1016h')

    await write(terminal, '\x1b[?1006h')
    const excluded = serializeWithAbsoluteCursor(addon, terminal, { excludeModes: true })
    expect(excluded).not.toContain('\x1b[?1006h')
  })

  it('carries the encoding from a renderer snapshot through a headless seed to its snapshot', async () => {
    // Why: the runtime seeds its headless model from the desktop pane's snapshot, and
    // mobile keeps only what follows the last `?1049h` of that model's snapshot.
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

  it('a snapshot from an older host without the encoding restores as before', async () => {
    const emulator = new HeadlessEmulator({ cols: 40, rows: 10 })
    await emulator.write('\x1b[?1049h\x1b[?1003hcodex')

    const snapshot = emulator.getSnapshot()

    expect(snapshot.modes.mouseTrackingMode).toBe('any')
    expect(snapshot.modes.sgrMouseMode).toBe(false)
    expect(snapshot.rehydrateSequences).not.toContain('\x1b[?1006h')
    emulator.dispose()
  })
})
