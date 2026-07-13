import { afterEach, describe, expect, it } from 'vitest'
import { HeadlessEmulator } from './headless-emulator'

function expectedNativePath(posixPath: string): string {
  return posixPath
}

describe('HeadlessEmulator', () => {
  let emulator: HeadlessEmulator

  afterEach(() => {
    emulator?.dispose()
  })

  describe('construction', () => {
    it('creates with specified dimensions', () => {
      emulator = new HeadlessEmulator({ cols: 120, rows: 40 })
      const snapshot = emulator.getSnapshot()
      expect(snapshot.cols).toBe(120)
      expect(snapshot.rows).toBe(40)
    })

    it('defaults cwd to null', () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      expect(emulator.getSnapshot().cwd).toBeNull()
    })
  })

  describe('write and snapshot', () => {
    it('captures written text in snapshot', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      await emulator.write('hello world')

      const snapshot = emulator.getSnapshot()
      expect(snapshot.snapshotAnsi).toContain('hello world')
    })

    it('captures PTY output in immediate snapshots without waiting for queued parsing', () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })

      void emulator.write('rendered before hidden restore snapshot')

      expect(emulator.getSnapshot().snapshotAnsi).toContain(
        'rendered before hidden restore snapshot'
      )
    })

    it('captures colored text', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      await emulator.write('\x1b[31mred text\x1b[0m')

      const snapshot = emulator.getSnapshot()
      expect(snapshot.snapshotAnsi).toContain('red text')
    })

    it('captures OSC 8 link ranges in snapshot metadata', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      await emulator.write('\x1b]8;;https://news.ycombinator.com\x07Hacker News\x1b]8;;\x07')

      expect(emulator.getSnapshot().oscLinks).toEqual([
        {
          row: 0,
          startCol: 0,
          endCol: 11,
          uri: 'https://news.ycombinator.com'
        }
      ])
    })

    it('captures scrollback OSC 8 ranges in unrestricted snapshots', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 2, scrollback: 10 })
      await emulator.write('\x1b]8;;https://example.com/old\x07old\x1b]8;;\x07\r\nplain\r\nvisible')

      expect(emulator.getSnapshot().oscLinks).toContainEqual({
        row: 0,
        startCol: 0,
        endCol: 3,
        uri: 'https://example.com/old'
      })
      expect(
        emulator
          .getSnapshot({ scrollbackRows: 0 })
          .oscLinks?.some((link) => link.uri === 'https://example.com/old')
      ).toBe(false)
    })

    it('projects restored OSC 8 ranges into serialized snapshot windows', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      await emulator.write('issue #1234 done')
      emulator.setRestoredOscLinks([
        { row: 0, startCol: 6, endCol: 11, uri: 'https://example.com/issue/1234' }
      ])

      expect(emulator.getSnapshot().oscLinks).toContainEqual({
        row: 0,
        startCol: 6,
        endCol: 11,
        uri: 'https://example.com/issue/1234'
      })
    })

    it('serializes split synchronized rich TUI frames for model-backed replay', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 12 })
      const richFrame = [
        '\x1b[?2026h',
        '\x1b[?1049h',
        '\x1b[2J\x1b[H',
        '\x1b[?25l',
        '\x1b[2;36m╭────────────────────────────╮\x1b[0m\r\n',
        '\x1b[2;36m│ Codex rich restore 🟢 ███░ │\x1b[0m\r\n',
        '\x1b[2;36m│ status streaming           │\x1b[0m\r\n',
        '\x1b[2;36m╰────────────────────────────╯\x1b[0m',
        '\x1b[6;4H\x1b[?25h',
        '\x1b[?2026l'
      ].join('')

      // Why: hidden rich TUI bytes may arrive split across DEC 2026 frame
      // boundaries; model/view work needs the headless model to preserve the
      // final visible state before renderer writes can be removed.
      await emulator.write(richFrame.slice(0, 17))
      await emulator.write(richFrame.slice(17, 91))
      await emulator.write(richFrame.slice(91))

      const snapshot = emulator.getSnapshot()
      expect(snapshot.modes.alternateScreen).toBe(true)
      expect(snapshot.snapshotAnsi).toContain('Codex rich restore')
      expect(snapshot.snapshotAnsi).toContain('🟢')
      expect(snapshot.snapshotAnsi).toContain('███░')
      expect(snapshot.snapshotAnsi).toContain('╭')
      expect(snapshot.snapshotAnsi).not.toContain('\x1b[?2026h')

      const replay = new HeadlessEmulator({ cols: snapshot.cols, rows: snapshot.rows })
      try {
        await replay.write(snapshot.rehydrateSequences + snapshot.snapshotAnsi)
        const replayed = replay.getSnapshot()
        expect(replayed.modes.alternateScreen).toBe(true)
        expect(replayed.snapshotAnsi).toContain('Codex rich restore')
        expect(replayed.snapshotAnsi).toContain('🟢')
        expect(replayed.snapshotAnsi).toContain('███░')
      } finally {
        replay.dispose()
      }
    })

    it('preserves the normal buffer behind an alternate-screen snapshot', async () => {
      emulator = new HeadlessEmulator({ cols: 40, rows: 6 })
      await emulator.write('shell history one\r\nshell history two')
      await emulator.write('\x1b[?1049h\x1b[2J\x1b[HTUI frame')

      const snapshot = emulator.getSnapshot()
      expect(snapshot.scrollbackAnsi).toContain('shell history one')
      expect(snapshot.snapshotAnsi).toContain('TUI frame')
      expect(snapshot.snapshotAnsi).not.toContain('shell history one')

      const replay = new HeadlessEmulator({ cols: snapshot.cols, rows: snapshot.rows })
      try {
        await replay.write(
          snapshot.scrollbackAnsi + snapshot.rehydrateSequences + snapshot.snapshotAnsi
        )
        expect(replay.getVisibleLines().join('\n')).toContain('TUI frame')

        await replay.write('\x1b[?1049l')
        expect(replay.getVisibleLines().join('\n')).toContain('shell history one')
        expect(replay.getVisibleLines().join('\n')).toContain('shell history two')
      } finally {
        replay.dispose()
      }
    })
  })

  describe('OSC-7 CWD tracking', () => {
    it('parses OSC-7 file URI to extract CWD', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      await emulator.write('\x1b]7;file://localhost/Users/test/project\x07')

      expect(emulator.getSnapshot().cwd).toBe(expectedNativePath('/Users/test/project'))
    })

    it('handles OSC-7 with empty host', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      await emulator.write('\x1b]7;file:///home/user/work\x07')

      expect(emulator.getSnapshot().cwd).toBe(expectedNativePath('/home/user/work'))
    })

    it('updates CWD when new OSC-7 arrives', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      await emulator.write('\x1b]7;file:///first\x07')
      expect(emulator.getSnapshot().cwd).toBe(expectedNativePath('/first'))

      await emulator.write('\x1b]7;file:///second\x07')
      expect(emulator.getSnapshot().cwd).toBe(expectedNativePath('/second'))
    })

    it('keeps earlier file CWD when a later OSC-7 URI is unsupported', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })

      await emulator.write('\x1b]7;file:///kept\x07\x1b]7;http://example.invalid/rejected\x07')

      expect(emulator.getSnapshot().cwd).toBe(expectedNativePath('/kept'))
    })

    it('decodes percent-encoded paths', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      await emulator.write('\x1b]7;file:///Users/test/my%20project\x07')

      expect(emulator.getSnapshot().cwd).toBe(expectedNativePath('/Users/test/my project'))
    })

    it('normalizes Windows drive-letter OSC-7 paths', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { value: 'win32' })

      try {
        await emulator.write('\x1b]7;file:///C:/Users/test/project\x07')
      } finally {
        if (platform) {
          Object.defineProperty(process, 'platform', platform)
        }
      }

      expect(emulator.getSnapshot().cwd).toBe('C:/Users/test/project')
    })

    it('preserves Windows UNC OSC-7 paths', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { value: 'win32' })

      try {
        await emulator.write('\x1b]7;file://server/share/project\x07')
      } finally {
        if (platform) {
          Object.defineProperty(process, 'platform', platform)
        }
      }

      expect(emulator.getSnapshot().cwd).toBe('\\\\server\\share\\project')
    })

    it('handles OSC-7 with ST terminator', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      await emulator.write('\x1b]7;file:///path/here\x1b\\')

      expect(emulator.getSnapshot().cwd).toBe(expectedNativePath('/path/here'))
    })

    it('tracks OSC-7 CWD across split PTY chunks', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })

      await emulator.write('\x1b]7;file:///split')
      await emulator.write('/project\x07')

      expect(emulator.getSnapshot().cwd).toBe(expectedNativePath('/split/project'))
    })

    it('tracks OSC-7 CWD when ESC and OSC marker arrive in separate chunks', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })

      await emulator.write('\x1b')
      await emulator.write(']7;file:///split-escape\x07')

      expect(emulator.getSnapshot().cwd).toBe(expectedNativePath('/split-escape'))
    })
  })

  describe('OSC title tracking', () => {
    it('captures the latest OSC window title in snapshots', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })

      await emulator.write('\x1b]0;Codex working\x07hello')

      expect(emulator.getSnapshot().lastTitle).toBe('Codex working')
    })

    it('uses the last OSC title when a chunk contains multiple title updates', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })

      await emulator.write('\x1b]0;Codex working\x07output\x1b]2;Codex idle\x1b\\')

      expect(emulator.getSnapshot().lastTitle).toBe('Codex idle')
    })

    it('tracks OSC titles across split PTY chunks', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })

      await emulator.write('\x1b]0;Codex work')
      await emulator.write('ing\x07')

      expect(emulator.getSnapshot().lastTitle).toBe('Codex working')
    })

    it('adopts title metadata seeded from an external serializer', () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })

      emulator.setLastTitle('Seeded renderer title')

      expect(emulator.getSnapshot().lastTitle).toBe('Seeded renderer title')
    })

    it('adopts cwd metadata seeded from persisted terminal history', () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })

      emulator.setCwd('/projects/restored')

      expect(emulator.getSnapshot().cwd).toBe('/projects/restored')
    })
  })

  describe('resize', () => {
    it('updates dimensions', () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      emulator.resize(120, 40)

      const snapshot = emulator.getSnapshot()
      expect(snapshot.cols).toBe(120)
      expect(snapshot.rows).toBe(40)
    })
  })

  describe('clear scrollback (CSI 3J)', () => {
    it('detects CSI 3J and clears scrollback', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      // Write enough lines to push into scrollback
      const lines = Array.from({ length: 30 }, (_, i) => `line ${i}\r\n`).join('')
      await emulator.write(lines)

      const before = emulator.getSnapshot()
      expect(before.scrollbackLines).toBeGreaterThan(0)

      await emulator.write('\x1b[3J')
      const after = emulator.getSnapshot()
      expect(after.scrollbackLines).toBe(0)
    })
  })

  describe('terminal modes', () => {
    it('tracks bracketed paste mode', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      expect(emulator.getSnapshot().modes.bracketedPaste).toBe(false)

      await emulator.write('\x1b[?2004h')
      expect(emulator.getSnapshot().modes.bracketedPaste).toBe(true)

      await emulator.write('\x1b[?2004l')
      expect(emulator.getSnapshot().modes.bracketedPaste).toBe(false)
    })

    it('tracks alternate screen mode', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      expect(emulator.getSnapshot().modes.alternateScreen).toBe(false)

      await emulator.write('\x1b[?1049h')
      expect(emulator.getSnapshot().modes.alternateScreen).toBe(true)

      await emulator.write('\x1b[?1049l')
      expect(emulator.getSnapshot().modes.alternateScreen).toBe(false)
    })

    it('tracks mouse reporting mode', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      expect(emulator.getSnapshot().modes.mouseTracking).toBe(false)

      await emulator.write('\x1b[?1002;1006h')
      expect(emulator.getSnapshot().modes.mouseTracking).toBe(true)
      expect(emulator.getSnapshot().modes.mouseTrackingMode).toBe('drag')
      expect(emulator.getSnapshot().modes.sgrMouseMode).toBe(true)
      expect(emulator.getSnapshot().modes.sgrMousePixelsMode).toBe(false)

      await emulator.write('\x1b[?1002;1006l')
      expect(emulator.getSnapshot().modes.mouseTracking).toBe(false)
      expect(emulator.getSnapshot().modes.sgrMouseMode).toBe(false)
    })

    it('tracks kitty keyboard flags for emulator re-seed parity', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      expect(emulator.getSnapshot().modes.kittyKeyboardFlags).toBe(0)

      await emulator.write('\x1b[=5;1u')
      expect(emulator.getSnapshot().modes.kittyKeyboardFlags).toBe(5)
    })

    it('round-trips a pushed CSI > 1 u flag through the core-internals read path', async () => {
      // Why: getKittyKeyboardFlags reads _core.coreService.kittyKeyboard.flags,
      // a private xterm surface. If an xterm upgrade breaks that path this
      // must fail loudly instead of the responder silently answering ?0u.
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })

      await emulator.write('\x1b[>1u')
      expect(emulator.getSnapshot().modes.kittyKeyboardFlags).toBe(1)
    })

    it('snapshots the active-buffer kitty flags (alt screen keeps its own set)', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      // Kitty flags are per screen buffer: entering the alt screen swaps to
      // its own (empty) flag set, exactly what a CSI ? u reply would report.
      await emulator.write('\x1b[=5;1u\x1b[?1049h')
      expect(emulator.getSnapshot().modes.kittyKeyboardFlags).toBe(0)

      await emulator.write('\x1b[=3;1u')
      expect(emulator.getSnapshot().modes.kittyKeyboardFlags).toBe(3)

      await emulator.write('\x1b[?1049l')
      expect(emulator.getSnapshot().modes.kittyKeyboardFlags).toBe(5)
    })

    it('never pushes kitty flags into rehydrateSequences', async () => {
      // Why: POST_REPLAY_REATTACH_RESET's deliberate kitty reset must stay
      // authoritative for renderer replays (terminal-query-authority.md).
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      await emulator.write('\x1b[?1049h\x1b[=5;1u')

      const snapshot = emulator.getSnapshot()
      expect(snapshot.modes.kittyKeyboardFlags).toBe(5)
      expect(snapshot.rehydrateSequences).not.toContain('u')
    })

    it('tracks split SGR mouse reporting sequences', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })

      await emulator.write('\x1b[?1002;100')
      await emulator.write('6h')
      expect(emulator.getSnapshot().modes.mouseTrackingMode).toBe('drag')
      expect(emulator.getSnapshot().modes.sgrMouseMode).toBe(true)

      await emulator.write('\x1b[?100')
      await emulator.write('6l')
      expect(emulator.getSnapshot().modes.sgrMouseMode).toBe(false)
    })

    it('tracks long split private mouse mode sequences', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      const fillerModes = Array.from({ length: 40 }, (_, i) => String(3000 + i)).join(';')

      await emulator.write(`\x1b[?1002;${fillerModes};100`)
      await emulator.write('6h')

      const snapshot = emulator.getSnapshot()
      expect(snapshot.modes.mouseTrackingMode).toBe('drag')
      expect(snapshot.modes.sgrMouseMode).toBe(true)
      expect(snapshot.rehydrateSequences).toContain('\x1b[?1002h')
      expect(snapshot.rehydrateSequences).toContain('\x1b[?1006h')
    })

    it('tracks private mouse modes with leading zero params', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })

      await emulator.write('\x1b[?01002;01006h')

      const snapshot = emulator.getSnapshot()
      expect(snapshot.modes.mouseTrackingMode).toBe('drag')
      expect(snapshot.modes.sgrMouseMode).toBe(true)
      expect(snapshot.rehydrateSequences).toContain('\x1b[?1002h')
      expect(snapshot.rehydrateSequences).toContain('\x1b[?1006h')
    })

    it('tracks C1 CSI private mouse mode sequences', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })

      await emulator.write('\x9b?1002;1006h')

      const snapshot = emulator.getSnapshot()
      expect(snapshot.modes.mouseTrackingMode).toBe('drag')
      expect(snapshot.modes.sgrMouseMode).toBe(true)
      expect(snapshot.rehydrateSequences).toContain('\x1b[?1002h')
      expect(snapshot.rehydrateSequences).toContain('\x1b[?1006h')
    })

    it('tracks split C1 CSI private mouse mode sequences', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })

      await emulator.write('\x9b?1002;100')
      await emulator.write('6h')
      await emulator.write('\x9b?1002l')

      const snapshot = emulator.getSnapshot()
      expect(snapshot.modes.mouseTracking).toBe(false)
      expect(snapshot.modes.sgrMouseMode).toBe(true)
      expect(snapshot.rehydrateSequences).not.toContain('\x1b[?1002h')
      expect(snapshot.rehydrateSequences).toContain('\x1b[?1006h')
    })

    it('tracks C1 CSI split before private marker', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })

      await emulator.write('\x9b')
      await emulator.write('?1002;1006h')

      const snapshot = emulator.getSnapshot()
      expect(snapshot.modes.mouseTrackingMode).toBe('drag')
      expect(snapshot.modes.sgrMouseMode).toBe(true)
      expect(snapshot.rehydrateSequences).toContain('\x1b[?1002h')
      expect(snapshot.rehydrateSequences).toContain('\x1b[?1006h')
    })

    it('does not retain complete private CSI queries as scan tail', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })

      await emulator.write('\x1b[?2004$p')
      await emulator.write('1002;1006h')

      const snapshot = emulator.getSnapshot()
      expect(snapshot.modes.mouseTracking).toBe(false)
      expect(snapshot.modes.sgrMouseMode).toBe(false)
      expect(snapshot.rehydrateSequences).not.toContain('\x1b[?1002h')
      expect(snapshot.rehydrateSequences).not.toContain('\x1b[?1006h')
    })

    it('keeps mode snapshots in sync with immediate headless parsing', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })

      const writePromise = emulator.write('\x1b[?1049h\x1b[?1002;1006h')
      const snapshot = emulator.getSnapshot()
      await writePromise

      expect(snapshot.modes.alternateScreen).toBe(true)
      expect(snapshot.modes.mouseTrackingMode).toBe('drag')
      expect(snapshot.modes.sgrMouseMode).toBe(true)
      expect(snapshot.rehydrateSequences).toContain('\x1b[?1049h')

      const after = emulator.getSnapshot()
      expect(after.modes.alternateScreen).toBe(true)
      expect(after.modes.mouseTrackingMode).toBe('drag')
      expect(after.modes.sgrMouseMode).toBe(true)
      expect(after.rehydrateSequences).toContain('\x1b[?1049h')
      expect(after.rehydrateSequences).toContain('\x1b[?1002h')
      expect(after.rehydrateSequences).toContain('\x1b[?1006h')
    })

    it('clears SGR mouse reporting on full terminal reset', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })

      await emulator.write('\x1b[?1002;1006h')
      await emulator.write('\x1bc')
      await emulator.write('\x1b[?1002h')

      const snapshot = emulator.getSnapshot()
      expect(snapshot.modes.mouseTrackingMode).toBe('drag')
      expect(snapshot.modes.sgrMouseMode).toBe(false)
      expect(snapshot.rehydrateSequences).toContain('\x1b[?1002h')
      expect(snapshot.rehydrateSequences).not.toContain('\x1b[?1006h')
    })

    it('tracks SGR-pixels mouse reporting as a separate active encoding', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })

      await emulator.write('\x1b[?1002;1006h')
      await emulator.write('\x1b[?1016h')

      const snapshot = emulator.getSnapshot()
      expect(snapshot.modes.mouseTrackingMode).toBe('drag')
      expect(snapshot.modes.sgrMouseMode).toBe(false)
      expect(snapshot.modes.sgrMousePixelsMode).toBe(true)
      expect(snapshot.rehydrateSequences).toContain('\x1b[?1002h')
      expect(snapshot.rehydrateSequences).toContain('\x1b[?1016h')
      expect(snapshot.rehydrateSequences).not.toContain('\x1b[?1006h')
    })
  })

  describe('rehydration sequences', () => {
    it('generates rehydration for non-default modes', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      await emulator.write('\x1b[?2004h')

      const snapshot = emulator.getSnapshot()
      expect(snapshot.rehydrateSequences).toContain('\x1b[?2004h')
    })

    it('generates empty rehydration when all modes are default', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      await emulator.write('just plain text')

      const snapshot = emulator.getSnapshot()
      expect(snapshot.rehydrateSequences).toBe('')
    })

    it('rehydrates mouse reporting after alternate screen activation', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      await emulator.write('\x1b[?1049h\x1b[?1002;1006h')

      const snapshot = emulator.getSnapshot()
      expect(snapshot.rehydrateSequences).toContain('\x1b[?1049h')
      expect(snapshot.rehydrateSequences).toContain('\x1b[?1002h')
      expect(snapshot.rehydrateSequences).toContain('\x1b[?1006h')
      expect(snapshot.rehydrateSequences.indexOf('\x1b[?1049h')).toBeLessThan(
        snapshot.rehydrateSequences.indexOf('\x1b[?1002h')
      )
    })

    it('preserves mouse modes after mobile normalizes an alternate-screen replay', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      await emulator.write('normal buffer\r\n\x1b[?1049h\x1b[?2004h\x1b[?1002;1006halternate')
      const snapshot = emulator.getSnapshot()
      const payload = snapshot.rehydrateSequences + snapshot.snapshotAnsi
      expect(payload.split('\x1b[?1049h')).toHaveLength(2)
      expect(payload.slice(payload.lastIndexOf('\x1b[?1049h'))).toContain('\x1b[?1002h')
      expect(payload.slice(payload.lastIndexOf('\x1b[?1049h'))).toContain('\x1b[?1006h')
    })

    it('rehydrates mouse encoding independently from reporting mode', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      await emulator.write('\x1b[?1002;1006h')
      await emulator.write('\x1b[?1002l')

      const snapshot = emulator.getSnapshot()
      expect(snapshot.modes.mouseTracking).toBe(false)
      expect(snapshot.modes.sgrMouseMode).toBe(true)
      expect(snapshot.rehydrateSequences).toContain('\x1b[?1006h')
      expect(snapshot.rehydrateSequences).not.toContain('\x1b[?1002h')
    })

    it('records kitty flags without pushing them into renderer rehydration', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      // OMP/pi negotiate progressive enhancement with a level-1 push.
      await emulator.write('\x1b[>1u')

      const snapshot = emulator.getSnapshot()
      expect(snapshot.modes.kittyKeyboardFlags).toBe(1)
      // Why: renderer replay deliberately resets stale CSI-u state; the daemon
      // warm-reattach path re-seeds the model from modes.kittyKeyboardFlags.
      expect(snapshot.rehydrateSequences).not.toContain('\x1b[=1;1u')
    })

    it('omits kitty rehydration after the TUI pops its flags', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      await emulator.write('\x1b[>1u')
      await emulator.write('\x1b[<u')

      const snapshot = emulator.getSnapshot()
      expect(snapshot.modes.kittyKeyboardFlags).toBe(0)
      expect(snapshot.rehydrateSequences).not.toContain('u')
    })

    it('keeps kitty flags out of alternate-screen renderer rehydration', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      await emulator.write('\x1b[?1049h\x1b[>1u')

      const snapshot = emulator.getSnapshot()
      const altScreenIndex = snapshot.rehydrateSequences.indexOf('\x1b[?1049h')
      const kittyIndex = snapshot.rehydrateSequences.indexOf('\x1b[=1;1u')
      expect(altScreenIndex).toBeGreaterThanOrEqual(0)
      expect(kittyIndex).toBe(-1)
    })

    it('drops kitty rehydration after a TUI soft reset (DECSTR)', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      await emulator.write('\x1b[>1u')
      await emulator.write('\x1b[!p')

      const snapshot = emulator.getSnapshot()
      expect(snapshot.modes.kittyKeyboardFlags).toBe(0)
    })
  })

  describe('dispose', () => {
    it('can be disposed without error', () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      expect(() => emulator.dispose()).not.toThrow()
    })
  })
})
