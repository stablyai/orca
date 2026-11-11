import { afterEach, describe, expect, it, vi } from 'vitest'
import { HeadlessEmulator } from '../headless-emulator'
import type {
  TerminalViewAttributes,
  TerminalViewRgb
} from '../../../../shared/terminal/protocol/queries/terminal-view-attributes'

function pushedAttributes(background: TerminalViewRgb): TerminalViewAttributes {
  return {
    foreground: [0xd0, 0xd0, 0xd0],
    background,
    cursor: [0xff, 0x99, 0x00],
    ansi: Array.from({ length: 256 }, (): TerminalViewRgb => [0xcc, 0x00, 0x00]),
    colorSchemeMode: 'dark',
    cursorStyle: 'bar',
    cursorBlink: true
  }
}

function expectedNativePath(posixPath: string): string {
  return posixPath
}

describe('HeadlessEmulator', () => {
  let emulator: HeadlessEmulator

  afterEach(() => {
    emulator?.dispose()
  })

  describe('write and snapshot', () => {
    it('captures PTY output in immediate snapshots without waiting for queued parsing', () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })

      void emulator.write('rendered before hidden restore snapshot')

      expect(emulator.getSnapshot().snapshotAnsi).toContain(
        'rendered before hidden restore snapshot'
      )
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

      // Split a rich TUI frame across writes to exercise DEC 2026 state retention.
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
    it('keeps earlier file CWD when a later OSC-7 URI is unsupported', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })

      await emulator.write('\x1b]7;file:///kept\x07\x1b]7;http://example.invalid/rejected\x07')

      expect(emulator.getSnapshot().cwd).toBe(expectedNativePath('/kept'))
    })

    it('tracks OSC-7 CWD across split PTY chunks', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })

      await emulator.write('\x1b]7;file:///split')
      await emulator.write('/project\x07')

      expect(emulator.getSnapshot().cwd).toBe(expectedNativePath('/split/project'))
    })

    it('keeps split WSL OSC-7 parsing scoped to each emulator distro', async () => {
      const ubuntu = new HeadlessEmulator({ cols: 80, rows: 24, wslDistro: 'Ubuntu' })
      const debian = new HeadlessEmulator({ cols: 80, rows: 24, wslDistro: 'Debian' })
      try {
        await ubuntu.write('\x1b]7;file://machine/home/jin')
        await debian.write('\x1b]7;file://machine/home/jin/repo\x07')
        await ubuntu.write('/repo\x07')

        expect(ubuntu.getSnapshot().cwd).toBe('\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo')
        expect(debian.getSnapshot().cwd).toBe('\\\\wsl.localhost\\Debian\\home\\jin\\repo')
      } finally {
        ubuntu.dispose()
        debian.dispose()
      }
    })
  })

  describe('rehydration sequences', () => {
    it('separates complete live state from an alternate-screen frame', async () => {
      emulator = new HeadlessEmulator({ cols: 80, rows: 24 })
      await emulator.write('\x1b[?1049h\x1b[?1004h\x1b[?25l\x1b[5;10H\x1b7\x1b[31;44;1mframe')

      const snapshot = emulator.getSnapshot()

      expect(snapshot.frameRestoreAnsi).toContain('\x1b[?1049h')
      expect(snapshot.frameRestoreAnsi).toContain('\x1b[?1004h')
      expect(snapshot.frameRestoreAnsi).toContain('\x1b[?25l')
      expect(snapshot.frameRestoreAnsi).toContain('\x1b7')
      expect(snapshot.frameRestoreAnsi).toContain('\x1b[31;44;1m')
      expect(snapshot.frameRestoreAnsi).not.toContain('frame')

      const restored = new HeadlessEmulator({ cols: 80, rows: 24 })
      await restored.write(snapshot.frameRestoreAnsi ?? '')
      expect(restored.isAlternateScreen).toBe(true)
      await restored.write('X')
      expect(restored.getSnapshot().snapshotAnsi).toContain('\x1b[31;44;1mX')
      restored.dispose()
    })

    it('restores current and saved cursor rows relative to origin-mode margins', async () => {
      emulator = new HeadlessEmulator({ cols: 20, rows: 10 })
      await emulator.write('\x1b[?1049h\x1b[3;8r\x1b[?6h\x1b[2;7H\x1b7\x1b[4;5H')

      const snapshot = emulator.getSnapshot()
      const restored = new HeadlessEmulator({ cols: 20, rows: 10 })
      await restored.write(snapshot.frameRestoreAnsi ?? '')
      await restored.write('C\x1b8S')

      expect(restored.getVisibleLines()[5]?.[4]).toBe('C')
      expect(restored.getVisibleLines()[3]?.[6]).toBe('S')
      restored.dispose()
    })

    it('restores a saved cursor from before the current origin-mode margins', async () => {
      emulator = new HeadlessEmulator({ cols: 20, rows: 10 })
      await emulator.write('\x1b[?1049h\x1b[1;3H\x1b7\x1b[3;8r\x1b[?6h\x1b[4;5H')

      const snapshot = emulator.getSnapshot()
      const restored = new HeadlessEmulator({ cols: 20, rows: 10 })
      await restored.write(snapshot.frameRestoreAnsi ?? '')
      await restored.write('C\x1b8S')

      expect(restored.getVisibleLines()[5]?.[4]).toBe('C')
      expect(restored.getVisibleLines()[0]?.[2]).toBe('S')
      restored.dispose()
    })
  })

  describe('pushed view attributes', () => {
    it('keeps OSC SET overlays while the base the PTY answered from is unchanged and drops them when a theme change moved it', async () => {
      const onQueryReply = vi.fn()
      emulator = new HeadlessEmulator({ cols: 80, rows: 24, onQueryReply })
      let base = pushedAttributes([0x1e, 0x1e, 0x2e])
      emulator.installViewAttributeResponder(() => base)
      emulator.applyPushedViewAttributes(base, null)
      const query = (): Promise<void> =>
        emulator.write('\x1b]4;1;?\x07', { forwardQueryReplies: true })

      await emulator.write('\x1b]4;1;#00ff00\x07', { forwardQueryReplies: true })
      // Same snapshot (e.g. a global push that leaves this PTY's repo palette alone).
      emulator.applyPushedViewAttributes(pushedAttributes([0x1e, 0x1e, 0x2e]), base)
      await query()
      expect(onQueryReply).toHaveBeenLastCalledWith('\x1b]4;1;rgb:0000/ffff/0000\x1b\\')

      const previous = base
      base = pushedAttributes([0x10, 0x20, 0x30])
      emulator.applyPushedViewAttributes(base, previous)
      await query()
      expect(onQueryReply).toHaveBeenLastCalledWith('\x1b]4;1;rgb:cccc/0000/0000\x1b\\')
    })

    it('keeps overlays set before main learned which base applies', async () => {
      const onQueryReply = vi.fn()
      emulator = new HeadlessEmulator({ cols: 80, rows: 24, onQueryReply })
      const globalBase = pushedAttributes([0xff, 0xff, 0xff])
      let base = globalBase
      emulator.installViewAttributeResponder(() => base)
      emulator.applyPushedViewAttributes(globalBase, null)
      await emulator.write('\x1b]4;1;#00ff00\x07', { forwardQueryReplies: true })

      // Worktree recorded after creation, or the first repo map arriving: the visible pane
      // painted this palette from its first frame, so nothing re-themed.
      base = pushedAttributes([0x00, 0x2b, 0x36])
      emulator.applyPushedViewAttributes(base, null)
      await emulator.write('\x1b]4;1;?\x07', { forwardQueryReplies: true })
      expect(onQueryReply).toHaveBeenLastCalledWith('\x1b]4;1;rgb:0000/ffff/0000\x1b\\')

      // A later push that leaves this PTY's base alone keeps them too.
      emulator.applyPushedViewAttributes(pushedAttributes([0x00, 0x2b, 0x36]), base)
      await emulator.write('\x1b]4;1;?\x07', { forwardQueryReplies: true })
      expect(onQueryReply).toHaveBeenLastCalledWith('\x1b]4;1;rgb:0000/ffff/0000\x1b\\')
    })

    it('keeps overlays when only cursor settings or the app mode change', async () => {
      const onQueryReply = vi.fn()
      emulator = new HeadlessEmulator({ cols: 80, rows: 24, onQueryReply })
      const base = pushedAttributes([0x00, 0x2b, 0x36])
      emulator.installViewAttributeResponder(() => base)
      emulator.applyPushedViewAttributes(base, null)
      await emulator.write('\x1b]4;1;#00ff00\x07\x1b]11;#101010\x07', { forwardQueryReplies: true })

      emulator.applyPushedViewAttributes({ ...base, cursorBlink: false }, base)
      emulator.applyPushedViewAttributes(
        { ...base, cursorBlink: false, cursorStyle: 'block' },
        base
      )
      emulator.applyPushedViewAttributes({ ...base, colorSchemeMode: 'light' }, base)
      await emulator.write('\x1b]4;1;?\x07\x1b]11;?\x07', { forwardQueryReplies: true })

      expect(onQueryReply.mock.calls).toEqual([
        ['\x1b]4;1;rgb:0000/ffff/0000\x1b\\'],
        ['\x1b]11;rgb:1010/1010/1010\x1b\\']
      ])
    })
  })
})
