import './mock-descendant-sweep'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalHost } from './terminal-host'
import { HeadlessEmulator } from './headless-emulator'
import type { SubprocessHandle } from './session-subprocess-handle'

function createMockSubprocess(): SubprocessHandle & {
  simulateData: (data: string) => void
  simulateExit: (code: number) => void
} {
  let onDataCb: ((data: string) => void) | null = null
  let onExitCb: ((code: number) => void) | null = null
  return {
    pid: 42,
    getForegroundProcess: vi.fn(() => null),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => setTimeout(() => onExitCb?.(0), 5)),
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: vi.fn(),
    signal: vi.fn(),
    onData(cb) {
      onDataCb = cb
    },
    onExit(cb) {
      onExitCb = cb
    },
    dispose: vi.fn(),
    simulateData(data: string) {
      onDataCb?.(data)
    },
    simulateExit(code: number) {
      onExitCb?.(code)
    }
  }
}

// This fixture assembles the payload locally; it does not exercise the adapter’s assembly.
function buildReattachPayload(snapshot: ReturnType<HeadlessEmulator['getSnapshot']>) {
  const isAltScreen = snapshot.modes.alternateScreen
  const fullPayload = snapshot.scrollbackAnsi + snapshot.rehydrateSequences + snapshot.snapshotAnsi
  return {
    rehydrateSequences: snapshot.rehydrateSequences,
    snapshotAnsi: snapshot.snapshotAnsi,
    fullPayload,
    isAlternateScreen: isAltScreen,
    cols: snapshot.cols,
    rows: snapshot.rows
  }
}

async function simulateReattachToFreshTerminal(
  reattachPayload: string,
  sigwinchRepaintData: string,
  cols: number,
  rows: number
): Promise<{ content: string; cols: number; rows: number }> {
  const fresh = new HeadlessEmulator({ cols, rows })
  try {
    await fresh.write(reattachPayload)
    await fresh.write(sigwinchRepaintData)
    const result = fresh.getSnapshot()
    return { content: result.snapshotAnsi, cols: result.cols, rows: result.rows }
  } finally {
    fresh.dispose()
  }
}

describe('reattach snapshot flow', () => {
  let host: TerminalHost
  let lastSub: ReturnType<typeof createMockSubprocess>

  afterEach(() => {
    host?.dispose()
  })

  function createHost() {
    host = new TerminalHost({
      spawnSubprocess: () => {
        lastSub = createMockSubprocess()
        return lastSub
      }
    })
    return host
  }

  describe('normal-screen TUI (Claude Code style)', () => {
    it('snapshot captures normal screen content and modes', async () => {
      const h = createHost()
      const onData = vi.fn()
      await h.createOrAttach({
        sessionId: 's1',
        cols: 80,
        rows: 24,
        streamClient: { onData, onExit: vi.fn() }
      })

      lastSub.simulateData('\x1b[?2004h')
      lastSub.simulateData('Claude Code > hello world\r\n')
      lastSub.simulateData('Response text here\r\n')

      // Allow the asynchronous emulator parse to settle before attaching.
      await new Promise((r) => setTimeout(r, 50))

      const result = await h.createOrAttach({
        sessionId: 's1',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      expect(result.isNew).toBe(false)
      expect(result.snapshot).toBeDefined()
      expect(result.snapshot!.modes.alternateScreen).toBe(false)
      expect(result.snapshot!.modes.bracketedPaste).toBe(true)
      expect(result.snapshot!.snapshotAnsi).toContain('hello world')
      expect(result.snapshot!.cols).toBe(80)
      expect(result.snapshot!.rows).toBe(24)
    })

    it('reattach payload includes snapshotAnsi for normal screen', async () => {
      const h = createHost()
      await h.createOrAttach({
        sessionId: 's1',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      lastSub.simulateData('\x1b[?2004h')
      lastSub.simulateData('prompt> ')
      await new Promise((r) => setTimeout(r, 50))

      const result = await h.createOrAttach({
        sessionId: 's1',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      const payload = buildReattachPayload(result.snapshot!)
      expect(payload.rehydrateSequences).toContain('\x1b[?2004h')
      expect(payload.snapshotAnsi).toContain('prompt>')
      expect(payload.fullPayload).toContain('prompt>')
      expect(payload.isAlternateScreen).toBe(false)
    })

    it('normal-screen payload restores modes and content', async () => {
      const h = createHost()
      await h.createOrAttach({
        sessionId: 's1',
        cols: 80,
        rows: 10,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      lastSub.simulateData('\x1b[?2004h')
      lastSub.simulateData('line 1\r\nline 2\r\nline 3\r\n')
      await new Promise((r) => setTimeout(r, 50))

      const result = await h.createOrAttach({
        sessionId: 's1',
        cols: 80,
        rows: 10,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      const payload = buildReattachPayload(result.snapshot!)
      const fresh = new HeadlessEmulator({ cols: 80, rows: 10 })
      await fresh.write(payload.fullPayload)
      const freshSnapshot = fresh.getSnapshot()
      fresh.dispose()

      expect(freshSnapshot.modes.bracketedPaste).toBe(true)
      expect(freshSnapshot.snapshotAnsi).toContain('line 1')
    })

    it('SIGWINCH repaint after snapshot produces clean state', async () => {
      const h = createHost()
      await h.createOrAttach({
        sessionId: 's1',
        cols: 80,
        rows: 10,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      lastSub.simulateData('original content\r\n')
      await new Promise((r) => setTimeout(r, 50))

      const result = await h.createOrAttach({
        sessionId: 's1',
        cols: 80,
        rows: 10,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      const payload = buildReattachPayload(result.snapshot!)
      const repaintData = '\x1b[2J\x1b[3J\x1b[Hrepainted content\r\n'
      const { content } = await simulateReattachToFreshTerminal(
        payload.fullPayload,
        repaintData,
        80,
        10
      )

      expect(content).toContain('repainted content')
      expect(content).not.toContain('original content')
    })
  })

  describe('alternate-screen TUI (Codex style)', () => {
    it('snapshot detects alternate screen mode', async () => {
      const h = createHost()
      await h.createOrAttach({
        sessionId: 's1',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      lastSub.simulateData('\x1b[?1049h')
      lastSub.simulateData('\x1b[?2004h')
      lastSub.simulateData('\x1b[H\x1b[2JCodex TUI content\r\n> input prompt')
      await new Promise((r) => setTimeout(r, 50))

      const result = await h.createOrAttach({
        sessionId: 's1',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      expect(result.snapshot!.modes.alternateScreen).toBe(true)
    })

    it('reattach payload includes snapshotAnsi for alternate screen', async () => {
      const h = createHost()
      await h.createOrAttach({
        sessionId: 's1',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      lastSub.simulateData('\x1b[?1049h')
      lastSub.simulateData('\x1b[?2004h')
      lastSub.simulateData('\x1b[H\x1b[2JCodex TUI content')
      await new Promise((r) => setTimeout(r, 50))

      const result = await h.createOrAttach({
        sessionId: 's1',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      const payload = buildReattachPayload(result.snapshot!)
      // Include alternate-screen content even when a SIGWINCH repaint never arrives.
      expect(payload.rehydrateSequences).toContain('\x1b[?1049h')
      expect(payload.rehydrateSequences).toContain('\x1b[?2004h')
      expect(payload.snapshotAnsi).toContain('Codex TUI content')
      expect(payload.fullPayload).toContain('Codex TUI content')
    })

    it('returns to preserved shell history after the reattached TUI exits', async () => {
      const emulator = new HeadlessEmulator({ cols: 80, rows: 10 })
      await emulator.write('shell output before Codex\r\n$ codex')
      await emulator.write('\x1b[?1049h\x1b[2J\x1b[HCodex TUI content')
      const payload = buildReattachPayload(emulator.getSnapshot())
      emulator.dispose()

      const replay = new HeadlessEmulator({ cols: 80, rows: 10 })
      try {
        await replay.write(payload.fullPayload)
        expect(replay.getVisibleLines().join('\n')).toContain('Codex TUI content')
        await replay.write('\x1b[?1049l')
        expect(replay.getVisibleLines().join('\n')).toContain('shell output before Codex')
      } finally {
        replay.dispose()
      }
    })

    it('SIGWINCH repaint after rehydrate produces clean single render', async () => {
      const h = createHost()
      await h.createOrAttach({
        sessionId: 's1',
        cols: 80,
        rows: 10,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      lastSub.simulateData('\x1b[?1049h\x1b[?2004h')
      lastSub.simulateData('\x1b[H\x1b[2Jold TUI content\r\n> old prompt')
      await new Promise((r) => setTimeout(r, 50))

      const result = await h.createOrAttach({
        sessionId: 's1',
        cols: 80,
        rows: 10,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      const payload = buildReattachPayload(result.snapshot!)
      const repaintData = '\x1b[H\x1b[2Jnew TUI content\r\n> new prompt'
      const { content } = await simulateReattachToFreshTerminal(
        payload.fullPayload,
        repaintData,
        80,
        10
      )

      expect(content).toContain('new TUI content')
      expect(content).toContain('new prompt')
      expect(content).not.toContain('old TUI content')
      expect(content).not.toContain('old prompt')
    })

    it('double SIGWINCH repaint at same dims does not duplicate content', async () => {
      const repaint = '\x1b[H\x1b[2Jcodex content\r\n> prompt'
      const fresh = new HeadlessEmulator({ cols: 80, rows: 10 })
      await fresh.write('\x1b[?1049h')
      await fresh.write(repaint)
      await fresh.write(repaint)

      const snapshot = fresh.getSnapshot()
      fresh.dispose()

      const matches = snapshot.snapshotAnsi.match(/codex content/g)
      expect(matches).toHaveLength(1)
    })
  })

  describe('Ink-style cursor-relative repaint (Codex)', () => {
    it('snapshot + Ink-style repaint overwrites correctly without clear', async () => {
      // Relative repaints depend on retaining the cursor position left by the previous render.
      const cols = 80
      const rows = 10
      const fresh = new HeadlessEmulator({ cols, rows })

      await fresh.write('old TUI header\r\n> old input\r\nstatus bar')

      await fresh.write('\x1b[3A\x1b[J')
      await fresh.write('new TUI header\r\n> new input\r\nnew status')

      const snapshot = fresh.getSnapshot()
      fresh.dispose()

      expect(snapshot.snapshotAnsi).toContain('new TUI header')
      expect(snapshot.snapshotAnsi).toContain('new input')
      expect(snapshot.snapshotAnsi).not.toContain('old TUI header')
      expect(snapshot.snapshotAnsi).not.toContain('old input')
    })

    it('clear before Ink repaint breaks cursor positioning', async () => {
      // This assertion checks content presence only; it does not prove cursor alignment.
      const cols = 80
      const rows = 10
      const fresh = new HeadlessEmulator({ cols, rows })

      await fresh.write('old TUI header\r\n> old input\r\nstatus bar')

      await fresh.write('\x1b[2J\x1b[3J\x1b[H')

      await fresh.write('\x1b[3A\x1b[J')
      await fresh.write('new TUI header\r\n> new input\r\nnew status')

      const snapshot = fresh.getSnapshot()
      fresh.dispose()

      expect(snapshot.snapshotAnsi).toContain('new TUI header')
    })

    it('Ink repaint with absolute row positioning breaks after clear', async () => {
      // This case uses absolute positioning without a clear; it does not test clear-induced corruption.
      const cols = 80
      const rows = 10
      const fresh = new HeadlessEmulator({ cols, rows })

      await fresh.write('\x1b[3;1Hheader line\r\n> prompt\r\nfooter')

      await fresh.write('\x1b[3;1H\x1b[Jnew header\r\n> new prompt\r\nnew footer')

      const snapshot = fresh.getSnapshot()
      fresh.dispose()

      expect(snapshot.snapshotAnsi).toContain('new header')
      expect(snapshot.snapshotAnsi).not.toContain('header line')
    })
  })

  describe('dimension handling', () => {
    it('snapshot dimensions match daemon session dimensions', async () => {
      const h = createHost()
      await h.createOrAttach({
        sessionId: 's1',
        cols: 120,
        rows: 30,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      lastSub.simulateData('content\r\n')
      await new Promise((r) => setTimeout(r, 50))

      const result = await h.createOrAttach({
        sessionId: 's1',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      expect(result.snapshot!.cols).toBe(120)
      expect(result.snapshot!.rows).toBe(30)
    })

    it('resize before reattach updates snapshot dimensions', async () => {
      const h = createHost()
      await h.createOrAttach({
        sessionId: 's1',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      h.resize('s1', 120, 30)

      lastSub.simulateData('content\r\n')
      await new Promise((r) => setTimeout(r, 50))

      const result = await h.createOrAttach({
        sessionId: 's1',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      expect(result.snapshot!.cols).toBe(120)
      expect(result.snapshot!.rows).toBe(30)
    })
  })

  describe('inline-viewport (Codex/ratatui) reattach', () => {
    it('fullPayload includes inline-viewport content for normal screen', async () => {
      const h = createHost()
      await h.createOrAttach({
        sessionId: 's1',
        cols: 80,
        rows: 10,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      lastSub.simulateData('task output line 1\r\n')
      lastSub.simulateData('task output line 2\r\n')
      lastSub.simulateData('task output line 3\r\n')
      lastSub.simulateData('╭─ Codex ──────────╮\r\n')
      lastSub.simulateData('│ Working...       │\r\n')
      lastSub.simulateData('╰──────────────────╯\r\n')
      await new Promise((r) => setTimeout(r, 50))

      const result = await h.createOrAttach({
        sessionId: 's1',
        cols: 80,
        rows: 10,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      expect(result.snapshot!.modes.alternateScreen).toBe(false)
      const payload = buildReattachPayload(result.snapshot!)

      expect(payload.snapshotAnsi).toContain('task output line 1')
      expect(payload.snapshotAnsi).toContain('Codex')
      expect(payload.fullPayload).toContain('Codex')
      expect(payload.isAlternateScreen).toBe(false)
    })

    it('full payload + SIGWINCH repaint produces clean viewport', async () => {
      const h = createHost()
      await h.createOrAttach({
        sessionId: 's1',
        cols: 80,
        rows: 10,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      lastSub.simulateData('history line 1\r\n')
      lastSub.simulateData('history line 2\r\n')
      lastSub.simulateData('viewport content\r\n')
      await new Promise((r) => setTimeout(r, 50))

      const result = await h.createOrAttach({
        sessionId: 's1',
        cols: 80,
        rows: 10,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      const payload = buildReattachPayload(result.snapshot!)

      const fresh = new HeadlessEmulator({ cols: 80, rows: 10 })
      await fresh.write('\x1b[2J\x1b[3J\x1b[H')
      await fresh.write(payload.fullPayload)
      await fresh.write('\x1b[4;1H\x1b[Jnew viewport content\r\n')

      const finalSnapshot = fresh.getSnapshot()
      fresh.dispose()

      expect(finalSnapshot.snapshotAnsi).toContain('new viewport content')
    })
  })

  describe('signal support', () => {
    it('host.signal sends signal to subprocess', async () => {
      const h = createHost()
      await h.createOrAttach({
        sessionId: 's1',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      h.signal('s1', 'SIGWINCH')
      expect(lastSub.signal).toHaveBeenCalledWith('SIGWINCH')
    })
  })
})
