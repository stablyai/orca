import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { HeadlessEmulator } from '../headless-emulator'
import { POST_REPLAY_REATTACH_RESET } from '../../../../shared/terminal/protocol/input-modes/terminal-mode-reset-profiles'

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
})
