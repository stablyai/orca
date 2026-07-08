import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { HeadlessEmulator } from './headless-emulator'

// Repro for #7329: "remote server + terminal" — typing gets escape sequences
// injected/wrapped around it and follow-up commands are corrupted.
//
// The remote-server path serializes terminal state on the daemon via
// HeadlessEmulator.getSnapshot() (SerializeAddon + buildRehydrateSequences) and
// replays it into the renderer xterm, then applies POST_REPLAY_REATTACH_RESET.
// This test drives the REAL daemon serializer and a REAL renderer-side xterm to
// see what the user's terminal ends up looking like after a subscribe/reattach.

const RESET_TERMINAL_CURSOR_STYLE = '\x1b[0 q'
const RESET_KITTY_KEYBOARD_PROTOCOL = '\x1b[<99u\x1b[=0u'
// Verbatim from layout-serialization.ts (the reattach path the remote onSnapshot uses).
const POST_REPLAY_REATTACH_RESET = `${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}\x1b[?25h\x1b[?1004l`

function writeXterm(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

async function emulatorWrite(emu: HeadlessEmulator, data: string): Promise<void> {
  await emu.write(data)
}

/** Replay a daemon snapshot into a renderer xterm exactly like the remote
 *  onSnapshot → replayDataCallback path: clear, write rehydrate+snapshot,
 *  then the reattach mode reset. */
async function replayRemoteSnapshot(
  term: Terminal,
  snapshot: { rehydrateSequences: string; snapshotAnsi: string; pendingEscapeTailAnsi?: string }
): Promise<void> {
  await writeXterm(term, '\x1b[2J\x1b[3J\x1b[H')
  await writeXterm(term, snapshot.rehydrateSequences + snapshot.snapshotAnsi)
  await writeXterm(term, POST_REPLAY_REATTACH_RESET)
  // The fix: the restorer writes the pending mid-escape tail LAST, after the
  // reset (mirrors drainReplayDataQueue in pty-connection.ts).
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
  it('leaves bracketed-paste + mouse modes armed after a reattach snapshot', async () => {
    const emu = new HeadlessEmulator({ cols: 80, rows: 24 })
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    try {
      // A live remote shell that armed bracketed paste (bash 4.4+/readline
      // default) and vt200+SGR mouse (a TUI the user just exited).
      await emulatorWrite(emu, '\x1b[?2004h\x1b[?1000h\x1b[?1006h')
      await emulatorWrite(emu, 'user@host:~$ ')

      const snapshot = emu.getSnapshot({ scrollbackRows: 0 })
      // The daemon snapshot re-arms the modes it observed.
      expect(snapshot.rehydrateSequences).toContain('\x1b[?2004h')
      expect(snapshot.modes.bracketedPaste).toBe(true)
      expect(snapshot.modes.mouseTracking).toBe(true)

      await replayRemoteSnapshot(term, snapshot)

      // After the remote reattach reset, the renderer xterm is STILL in
      // bracketed-paste + mouse mode — even though POST_REPLAY_REATTACH_RESET
      // ran. Cold restore's POST_REPLAY_MODE_RESET would have cleared these.
      expect(term.modes.bracketedPasteMode).toBe(true) // leak
      expect(term.modes.mouseTrackingMode).not.toBe('none') // leak
    } finally {
      emu.dispose()
      term.dispose()
    }
  })

  it('drops a mid-escape tail so continuation bytes render literally after reattach', async () => {
    const emu = new HeadlessEmulator({ cols: 80, rows: 24 })
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    try {
      // A remote PTY read that ends mid-escape: the shell was about to paint a
      // colored prompt but the read boundary split the SGR sequence. The next
      // read carries the continuation. The daemon serializes BETWEEN the two
      // reads (e.g. the client subscribes/reattaches right then).
      await emulatorWrite(emu, 'first line\r\n')
      await emulatorWrite(emu, '\x1b[3') // <-- partial SGR: "\x1b[38;5;...m" started

      const snapshot = emu.getSnapshot({ scrollbackRows: 0 })
      // The serializer still cannot put the dangling "\x1b[3" in the screen ANSI
      // (it lives in the parser)...
      expect(snapshot.snapshotAnsi).not.toContain('\x1b[3')
      // ...but the emulator now ships it as a separate pending-escape tail.
      expect(snapshot.pendingEscapeTailAnsi).toBe('\x1b[3')

      await replayRemoteSnapshot(term, snapshot)

      // The continuation of the split escape arrives as the next live chunk.
      await writeXterm(term, '8;5;196mred$ yes\r\n')

      const visible = renderVisible(term)
      // FIXED: the tail was replayed after the reset, so the continuation
      // "8;5;196m" completes the SGR escape and is consumed — not rendered
      // literally. The visible text is just the prompt + typed command.
      expect(visible).not.toContain('8;5;196m')
      expect(visible).toContain('red$ yes')
    } finally {
      emu.dispose()
      term.dispose()
    }
  })

  it('does not eat the continuation byte when the tail and continuation are contiguous', async () => {
    // The safety property the fix relies on (mirrors the snapshot-seq accounting
    // in orca-runtime/getOutputAfterSnapshotSeq): the snapshot seq counts the
    // tail bytes, so the FIRST live chunk after the snapshot is the exact
    // continuation and completes the dangling sequence with no eaten byte.
    const emu = new HeadlessEmulator({ cols: 80, rows: 24 })
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    try {
      await emulatorWrite(emu, '\x1b[38;5;') // dangling: params so far
      const snapshot = emu.getSnapshot({ scrollbackRows: 0 })
      expect(snapshot.pendingEscapeTailAnsi).toBe('\x1b[38;5;')
      await replayRemoteSnapshot(term, snapshot)
      // Continuation completes the SGR then prints a visible token.
      await writeXterm(term, '82mHELLO')
      const visible = renderVisible(term)
      // No byte of "82m" leaks; the token renders whole (color applied).
      expect(visible).toBe('HELLO')
    } finally {
      emu.dispose()
      term.dispose()
    }
  })

  it('documents the residual edge: an idle-death tail eats the next output byte', async () => {
    // KNOWN, ACCEPTED trade-off: if a mid-escape read is the LAST thing the
    // process emits (it dies/idles and never sends the continuation), the tail
    // sits armed in the parser and the NEXT unrelated output loses its first
    // byte. This is strictly narrower than the bug it fixes (which garbled every
    // real split escape), and pre-fix such a stream simply dropped the partial.
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    try {
      await writeXterm(term, 'prompt$ ')
      await writeXterm(term, '\x1b[3') // armed tail, no continuation ever comes
      await writeXterm(term, 'yes\r\n') // unrelated later output
      // The 'y' is absorbed as a CSI parameter of the dangling sequence.
      expect(renderVisible(term)).toBe('prompt$ es')
    } finally {
      term.dispose()
    }
  })
})
