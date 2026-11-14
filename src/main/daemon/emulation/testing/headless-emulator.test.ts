import { Terminal } from '@xterm/headless'
import { HeadlessContentOrigins } from '../headless-content-origins'
import {
  originTerminalCore,
  type OriginBufferLine,
  type OriginLineState
} from '../headless-content-origin-lines'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HeadlessEmulator } from '../headless-emulator'
import { compileTextTest } from '../../../runtime/agent-state-rules/agent-state-rule-matchers'
import {
  joinedTerminalOrigins,
  terminalSupportQuery,
  terminalScreenSupport,
  type TerminalOriginRuns
} from '../../../../shared/terminal/output/terminal-content-origin'

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
})

describe('action support follows the live terminal editor', () => {
  it('does not treat a shifted empty wide-cell continuation as predecessor text', async () => {
    const emulator = new HeadlessEmulator({ cols: 12, rows: 3 })
    const owner = {}
    const current = { owner, epoch: 2 }
    try {
      await emulator.write('界X', { contentOrigin: { owner, epoch: 1 } })
      await emulator.write('\r\x1b[2G\x1b[@\rA\x1b[4Gnew', { contentOrigin: current })
      const lines = emulator.getVisibleActionLines(current)
      const joined = joinedTerminalOrigins(lines)
      expect(lines[0]).toBe('A  new')
      expect(
        compileTextTest({ contains: 'A  new' })(
          joined.text,
          terminalSupportQuery(joined.origins, current)
        )
      ).toBe(true)
    } finally {
      emulator.dispose()
    }
  })

  it('keeps predecessor text old through mixed writes, shifts, erase and identical repaint', async () => {
    const emulator = new HeadlessEmulator({ cols: 24, rows: 3 })
    const owner = {}
    const old = { owner, epoch: 1 }
    const current = { owner, epoch: 2 }
    const readable = () => {
      const lines = emulator.getVisibleActionLines(current)
      return compileTextTest({ contains: 'ready' })(
        lines[0]!,
        terminalScreenSupport(lines, current)
          ? (start, end) => terminalScreenSupport(lines, current)!(0, start, end)
          : undefined
      )
    }
    try {
      await emulator.write('ready old', { contentOrigin: old })
      await emulator.write('\r\x1b[6Gnew', { contentOrigin: current })
      expect(readable()).toBe(false)
      await emulator.write('\r\x1b[2@', { contentOrigin: current })
      expect(emulator.getVisibleLines()[0]).toBe('  readynewd')
      expect(readable()).toBe(false)
      await emulator.write('\r\x1b[2P', { contentOrigin: current })
      expect(readable()).toBe(false)
      await emulator.write('\rready', { contentOrigin: current })
      expect(readable()).toBe(true)
      await emulator.write('\r\x1b[2K', { contentOrigin: current })
      expect(readable()).toBe(false)
    } finally {
      emulator.dispose()
    }
  })

  it('preserves a combined base and copied wide glyph while later repaint becomes eligible', async () => {
    const emulator = new HeadlessEmulator({ cols: 12, rows: 3 })
    const owner = {}
    const current = { owner, epoch: 2 }
    const eligible = (term: string) => {
      const lines = emulator.getVisibleActionLines(current)
      const joined = joinedTerminalOrigins(lines)
      return compileTextTest({ contains: term })(
        joined.text,
        terminalSupportQuery(joined.origins, current)
      )
    }
    try {
      await emulator.write('e界 old', { contentOrigin: { owner, epoch: 1 } })
      await emulator.write('\r\x1b[C\u0301', { contentOrigin: current })
      expect(eligible('e\u0301')).toBe(false)
      emulator.resize(5, 4)
      expect(eligible('界')).toBe(false)
      await emulator.write('\x1b[He\u0301界', { contentOrigin: current })
      expect(eligible('e\u0301界')).toBe(true)
    } finally {
      emulator.dispose()
    }
  })

  it('keeps an opaque seed eligible and tracks future writes in rows created by resize', async () => {
    const emulator = new HeadlessEmulator({ cols: 20, rows: 2 })
    const owner = {}
    const current = { owner, epoch: 2 }
    const eligible = () => {
      const joined = joinedTerminalOrigins(emulator.getVisibleActionLines(current))
      return compileTextTest({ contains: 'ready' })(
        joined.text,
        terminalSupportQuery(joined.origins, current)
      )
    }
    try {
      await emulator.write('ready')
      expect(eligible()).toBe(true)
      emulator.resize(20, 4)
      await emulator.write('\x1b[4;1Hready', { contentOrigin: { owner, epoch: 1 } })
      await emulator.write('\x1b[H\x1b[2K', { contentOrigin: current })
      expect(eligible()).toBe(false)
      await emulator.write('\x1b[4;1Hready', { contentOrigin: current })
      expect(eligible()).toBe(true)
    } finally {
      emulator.dispose()
    }
  })
})

it.each([100, 1000])(
  'bounds attribution work for %i wide and joined glyphs on the real editor',
  async (count) => {
    const owner = {}
    const scope = { owner, epoch: 1 }
    const terminal = new Terminal({ cols: count * 2 + 2, rows: 2, allowProposedApi: true })
    const origins = new HeadlessContentOrigins(terminal)
    let runVisits = 0
    let componentCopies = 0
    const arrays = new WeakMap<TerminalOriginRuns, TerminalOriginRuns>()
    const maps = new WeakMap<Map<number, TerminalOriginRuns>, Map<number, TerminalOriginRuns>>()
    const observeRuns = (runs: TerminalOriginRuns): TerminalOriginRuns => {
      const cached = arrays.get(runs)
      if (cached) {
        return cached
      }
      const observed = new Proxy(runs, {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^\d+$/.test(key)) {
            runVisits++
          }
          // oxlint-disable-next-line anti-slop/no-reflect-get -- Transparent test instrumentation must preserve arbitrary array accessors.
          return Reflect.get(target, key, receiver)
        }
      })
      arrays.set(runs, observed)
      arrays.set(observed, observed)
      return observed
    }
    const observeComponents = (components: Map<number, TerminalOriginRuns>) => {
      const cached = maps.get(components)
      if (cached) {
        return cached
      }
      const observed = new Proxy(components, {
        get(target, key) {
          if (key === Symbol.iterator || key === 'entries') {
            return function* () {
              for (const entry of target) {
                componentCopies++
                yield entry
              }
            }
          }
          // oxlint-disable-next-line anti-slop/no-reflect-get -- Preserve Map accessors while observing only iteration on this instance.
          const value = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
      maps.set(components, observed)
      maps.set(observed, observed)
      return observed
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test observes only this instance's existing assignment seam.
    const seam = origins as unknown as {
      assign(line: OriginBufferLine, state: OriginLineState): void
    }
    const assign = seam.assign.bind(origins)
    const spy = vi.spyOn(seam, 'assign').mockImplementation((line, state) => {
      assign(line, {
        runs: observeRuns(state.runs),
        components: state.components ? observeComponents(state.components) : undefined
      })
    })
    const write = async (data: string) => {
      origins.begin(scope)
      await new Promise<void>((resolve) => terminal.write(data, resolve))
      origins.end()
    }
    let visible: string[] = []
    try {
      await write('界'.repeat(count))
      await write(`\r\n${'e\u0301'.repeat(count)}`)
      visible = origins.read(scope)
      expect(origins.read(scope)).toBe(visible)
    } finally {
      spy.mockRestore()
      terminal.dispose()
    }
    expect(visible[0]).toBe('界'.repeat(count))
    expect(visible[1]).toBe('e\u0301'.repeat(count))
    // Two input codepoints per joined cell, at most eight bounded metadata passes plus projection.
    expect(runVisits).toBeLessThanOrEqual(count * 32)
    // Printing same-origin joins never copies exceptional entries from the rest of the row.
    expect(componentCopies).toBe(0)
  }
)

it('keeps loaded-cell snapshots and copied mixed glyphs independent of later source edits', async () => {
  const terminal = new Terminal({ cols: 12, rows: 2, allowProposedApi: true })
  const origins = new HeadlessContentOrigins(terminal)
  const owner = {}
  const old = { owner, epoch: 1 }
  const current = { owner, epoch: 2 }
  const write = async (data: string, scope = old) => {
    origins.begin(scope)
    await new Promise<void>((resolve) => terminal.write(data, resolve))
    origins.end()
  }
  const eligible = (start: number, end: number) =>
    terminalScreenSupport(origins.read(current), current)?.(0, start, end) ?? true
  try {
    await write('eX')
    const line = originTerminalCore(terminal)!.buffers.active.lines.get(0)!
    const cell = terminal.buffer.active.getLine(0)!.getCell(1)!
    line.loadCell(1, cell)
    await write('\r\x1b[CZ', current)
    line.setCell(4, cell)
    expect(terminal.buffer.active.getLine(0)!.translateToString(true)).toBe('eZ  X')
    expect(eligible(4, 5)).toBe(false)
    await write('\r\x1b[C\u0301', current)
    const copy = line.clone()
    await write('\rQ', current)
    line.copyFrom(copy)
    expect(eligible(0, 2)).toBe(false)
    origins.begin(current)
    copy.setCellFromCodepoint(0, 81, 1, {})
    origins.end()
    expect(eligible(0, 2)).toBe(false)
    origins.begin(current)
    line.copyCellsFrom(line, 0, 1, 2, false)
    origins.end()
    expect(eligible(1, 3)).toBe(false)
  } finally {
    terminal.dispose()
  }
})

it('attributes an empty-base native combine without affecting an interleaved default editor', async () => {
  const terminal = new Terminal({ cols: 8, rows: 2, allowProposedApi: true })
  const plain = new Terminal({ cols: 8, rows: 2, allowProposedApi: true })
  const origins = new HeadlessContentOrigins(terminal)
  const owner = {}
  const old = { owner, epoch: 1 }
  const current = { owner, epoch: 2 }
  try {
    origins.begin(old)
    await new Promise<void>((resolve) => terminal.write('界X', resolve))
    origins.end()
    origins.begin(current)
    await new Promise<void>((resolve) => terminal.write('\r\x1b[2G\x1b[@', resolve))
    const line = originTerminalCore(terminal)!.buffers.active.lines.get(0)!
    const defaultLine = originTerminalCore(plain)!.buffers.active.lines.get(0)!
    defaultLine.addCodepointToCell(0, 0x1f600, 0)
    line.addCodepointToCell(2, 0x1f600, 0)
    origins.end()
    const lines = origins.read(current)
    expect(lines[0]).toBe('  😀X')
    expect(plain.buffer.active.getLine(0)!.translateToString(true)).toBe('😀')
    expect(terminalScreenSupport(lines, current)?.(0, 2, 4)).toBe(true)
    expect(terminalScreenSupport(lines, current)?.(0, 4, 5)).toBe(false)
    expect(
      terminalScreenSupport(origins.read({ owner, epoch: 3 }), { owner, epoch: 3 })?.(0, 2, 4)
    ).toBe(false)
  } finally {
    terminal.dispose()
    plain.dispose()
  }
})
