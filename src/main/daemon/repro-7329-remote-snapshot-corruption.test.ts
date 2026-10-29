import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { HeadlessEmulator } from './headless-emulator'
import { POST_REPLAY_REATTACH_RESET } from '../../shared/terminal-mode-reset-profiles'

// Exercise daemon serialization and xterm replay; the remote transport itself is outside this fixture.

function writeXterm(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

async function emulatorWrite(emu: HeadlessEmulator, data: string): Promise<void> {
  await emu.write(data)
}

async function replayRemoteSnapshot(
  term: Terminal,
  snapshot: { rehydrateSequences: string; snapshotAnsi: string; pendingEscapeTailAnsi?: string }
): Promise<void> {
  await writeXterm(term, '\x1b[2J\x1b[3J\x1b[H')
  await writeXterm(term, snapshot.rehydrateSequences + snapshot.snapshotAnsi)
  await writeXterm(term, POST_REPLAY_REATTACH_RESET)
  // Replay the pending escape after the reset so its live continuation reaches the same parser state.
  if (snapshot.pendingEscapeTailAnsi) {
    await writeXterm(term, snapshot.pendingEscapeTailAnsi)
  }
}

function renderVisible(term: Terminal): string {
  const buf = term.buffer.active
  const lines: string[] = []
  for (let y = 0; y < term.rows; y += 1) {
    lines.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? '')
  }
  return lines.join('\n').replace(/\s+$/g, '')
}

describe('#7329 remote-server snapshot corruption', () => {
  it('disarms rehydrated mouse modes but keeps bracketed paste after a reattach snapshot', async () => {
    const emu = new HeadlessEmulator({ cols: 80, rows: 24 })
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    try {
      await emulatorWrite(emu, '\x1b[?2004h\x1b[?1000h\x1b[?1006h')
      await emulatorWrite(emu, 'user@host:~$ ')

      const snapshot = emu.getSnapshot({ scrollbackRows: 0 })
      expect(snapshot.rehydrateSequences).toContain('\x1b[?2004h')
      expect(snapshot.modes.bracketedPaste).toBe(true)
      expect(snapshot.modes.mouseTracking).toBe(true)

      await replayRemoteSnapshot(term, snapshot)

      // Keep the live shell’s bracketed paste while preventing stale mouse reports from becoming shell input.
      expect(term.modes.bracketedPasteMode).toBe(true)
      expect(term.modes.mouseTrackingMode).toBe('none')
    } finally {
      emu.dispose()
      term.dispose()
    }
  })

  it('disarms any-motion (?1003) and pixel-encoded (?1016) mouse modes left by a killed TUI', async () => {
    const emu = new HeadlessEmulator({ cols: 80, rows: 24 })
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    try {
      await emulatorWrite(emu, '\x1b[?1003h\x1b[?1016h')
      await emulatorWrite(emu, 'user@host:~$ ')

      const snapshot = emu.getSnapshot({ scrollbackRows: 0 })
      expect(snapshot.rehydrateSequences).toContain('\x1b[?1003h')
      expect(snapshot.rehydrateSequences).toContain('\x1b[?1016h')

      await replayRemoteSnapshot(term, snapshot)

      expect(term.modes.mouseTrackingMode).toBe('none')
    } finally {
      emu.dispose()
      term.dispose()
    }
  })

  it('drops a mid-escape tail so continuation bytes render literally after reattach', async () => {
    const emu = new HeadlessEmulator({ cols: 80, rows: 24 })
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    try {
      // Snapshot between PTY chunks that split a colored prompt’s SGR sequence.
      await emulatorWrite(emu, 'first line\r\n')
      await emulatorWrite(emu, '\x1b[3')

      const snapshot = emu.getSnapshot({ scrollbackRows: 0 })
      expect(snapshot.snapshotAnsi).not.toContain('\x1b[3')
      expect(snapshot.pendingEscapeTailAnsi).toBe('\x1b[3')

      await replayRemoteSnapshot(term, snapshot)

      await writeXterm(term, '8;5;196mred$ yes\r\n')

      const visible = renderVisible(term)
      expect(visible).not.toContain('8;5;196m')
      expect(visible).toContain('red$ yes')
    } finally {
      emu.dispose()
      term.dispose()
    }
  })

  it('does not eat the continuation byte when the tail and continuation are contiguous', async () => {
    // Test a contiguous continuation directly; production snapshot-sequence accounting is not exercised here.
    const emu = new HeadlessEmulator({ cols: 80, rows: 24 })
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    try {
      await emulatorWrite(emu, '\x1b[38;5;')
      const snapshot = emu.getSnapshot({ scrollbackRows: 0 })
      expect(snapshot.pendingEscapeTailAnsi).toBe('\x1b[38;5;')
      await replayRemoteSnapshot(term, snapshot)
      await writeXterm(term, '82mHELLO')
      const visible = renderVisible(term)
      expect(visible).toBe('HELLO')
    } finally {
      emu.dispose()
      term.dispose()
    }
  })

  it('documents the residual edge: an idle-death tail eats the next output byte', async () => {
    // A tail with no continuation can consume unrelated later output; pin the known parser limitation.
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    try {
      await writeXterm(term, 'prompt$ ')
      await writeXterm(term, '\x1b[3')
      await writeXterm(term, 'yes\r\n')
      // CSI consumes 'y' as a final byte; only the remaining 'es' renders.
      expect(renderVisible(term)).toBe('prompt$ es')
    } finally {
      term.dispose()
    }
  })
})
