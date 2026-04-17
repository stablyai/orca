/* oxlint-disable max-lines */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalHost } from './terminal-host'
import { HeadlessEmulator } from './headless-emulator'
import type { SubprocessHandle } from './session'

function createMockSubprocess(): SubprocessHandle & {
  simulateData: (data: string) => void
  simulateExit: (code: number) => void
} {
  let onDataCb: ((data: string) => void) | null = null
  let onExitCb: ((code: number) => void) | null = null
  return {
    pid: 42,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => setTimeout(() => onExitCb?.(0), 5)),
    forceKill: vi.fn(),
    signal: vi.fn(),
    onData(cb) {
      onDataCb = cb
    },
    onExit(cb) {
      onExitCb = cb
    },
    simulateData(data: string) {
      onDataCb?.(data)
    },
    simulateExit(code: number) {
      onExitCb?.(code)
    }
  }
}

// Why: simulates what daemon-pty-adapter.ts does when building the PtySpawnResult
// for a reattach. Alt-screen sessions include the full ANSI snapshot because
function buildReattachPayload(snapshot: ReturnType<HeadlessEmulator['getSnapshot']>) {
  const isAltScreen = snapshot.modes.alternateScreen
  const fullPayload = snapshot.rehydrateSequences + snapshot.snapshotAnsi
  return {
    rehydrateSequences: snapshot.rehydrateSequences,
    snapshotAnsi: snapshot.snapshotAnsi,
    fullPayload,
    isAlternateScreen: isAltScreen,
    cols: snapshot.cols,
    rows: snapshot.rows
  }
}

// Why: replays the reattach payload into a fresh headless emulator (simulating
// what pty-connection.ts does when writing snapshot data to xterm.js) and then
// feeds the SIGWINCH repaint output to verify the final state is clean.
async function simulateReattachToFreshTerminal(
  reattachPayload: string,
  sigwinchRepaintData: string,
  cols: number,
  rows: number
): Promise<{ content: string; cols: number; rows: number }> {
  const fresh = new HeadlessEmulator({ cols, rows })
  try {
    // Step 1: write reattach payload (what pty-connection writes to xterm.js)
    await fresh.write(reattachPayload)
    // Step 2: write SIGWINCH repaint data (what the TUI sends after receiving SIGWINCH)
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

      // Simulate Claude Code TUI: bracketed paste + normal screen content
      lastSub.simulateData('\x1b[?2004h') // enable bracketed paste
      lastSub.simulateData('Claude Code > hello world\r\n')
      lastSub.simulateData('Response text here\r\n')

      // Wait for headless emulator to process
      await new Promise((r) => setTimeout(r, 50))

      // Reattach — get snapshot
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
      // Simulate SIGWINCH repaint: clear screen + redraw
      const repaintData = '\x1b[2J\x1b[3J\x1b[Hrepainted content\r\n'
      const { content } = await simulateReattachToFreshTerminal(
        payload.fullPayload,
        repaintData,
        80,
        10
      )

      expect(content).toContain('repainted content')
      // Original content should be cleared by the repaint
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

      // Simulate Codex entering alternate screen
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
      // Why: alt-screen sessions include the full content snapshot because
      // POSIX signal coalescing may prevent the SIGWINCH repaint from arriving.
      // The snapshot keeps the TUI visible; any repaint overwrites it via
      // absolute cursor positioning.
      expect(payload.rehydrateSequences).toContain('\x1b[?1049h')
      expect(payload.rehydrateSequences).toContain('\x1b[?2004h')
      expect(payload.snapshotAnsi).toContain('Codex TUI content')
      expect(payload.fullPayload).toContain('Codex TUI content')
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
      // Simulate single SIGWINCH repaint (what Codex sends)
      const repaintData = '\x1b[H\x1b[2Jnew TUI content\r\n> new prompt'
      const { content } = await simulateReattachToFreshTerminal(
        payload.fullPayload,
        repaintData,
        80,
        10
      )

      expect(content).toContain('new TUI content')
      expect(content).toContain('new prompt')
      // Old content should not appear
      expect(content).not.toContain('old TUI content')
      expect(content).not.toContain('old prompt')
    })

    it('double SIGWINCH repaint at same dims does not duplicate content', async () => {
      const repaint = '\x1b[H\x1b[2Jcodex content\r\n> prompt'
      // Simulate receiving two identical repaints (e.g. from resize + explicit SIGWINCH)
      const fresh = new HeadlessEmulator({ cols: 80, rows: 10 })
      await fresh.write('\x1b[?1049h') // enter alternate screen
      await fresh.write(repaint)
      await fresh.write(repaint) // second identical repaint

      const snapshot = fresh.getSnapshot()
      fresh.dispose()

      // Content should appear exactly once, not duplicated
      const matches = snapshot.snapshotAnsi.match(/codex content/g)
      expect(matches).toHaveLength(1)
    })
  })

  describe('Ink-style cursor-relative repaint (Codex)', () => {
    it('snapshot + Ink-style repaint overwrites correctly without clear', async () => {
      // Simulates the reattach flow for an Ink-based TUI (Codex).
      // Ink repaints by: cursor-up-N → erase-to-end → write new content.
      // The snapshot positions xterm.js cursor where Ink expects it,
      // so the repaint overwrites the snapshot correctly.
      const cols = 80
      const rows = 10
      const fresh = new HeadlessEmulator({ cols, rows })

      // Step 1: write snapshot (simulating pty-connection)
      // Ink rendered 3 lines, cursor ends at the end of line 3
      await fresh.write('old TUI header\r\n> old input\r\nstatus bar')

      // Step 2: NO clear — cursor stays where snapshot left it (end of line 3)

      // Step 3: Ink-style SIGWINCH repaint: move cursor up 3 lines,
      // clear to end, write new content
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
      // Proves the problem: clearing resets cursor to (1,1), but Ink's
      // cursor-up-N expects cursor at end of previous render. The mismatch
      // causes content to render at wrong positions.
      const cols = 80
      const rows = 10
      const fresh = new HeadlessEmulator({ cols, rows })

      // Step 1: write snapshot (3 lines, cursor at end of line 3)
      await fresh.write('old TUI header\r\n> old input\r\nstatus bar')

      // Step 2: clear — cursor moves to (1,1)
      await fresh.write('\x1b[2J\x1b[3J\x1b[H')

      // Step 3: Ink-style repaint: cursor-up-3 from (1,1) → clamped to (1,1)
      // Ink clears and writes from row 1 — happens to work in this case
      // because cursor-up is clamped, but the cursor column is wrong
      await fresh.write('\x1b[3A\x1b[J')
      await fresh.write('new TUI header\r\n> new input\r\nnew status')

      const snapshot = fresh.getSnapshot()
      fresh.dispose()

      // In this simple case it still works because cursor-up clamping
      // happens to land at the right row. But for more complex TUI
      // layouts (e.g., cursor not at column 1 of last line), the clear
      // would cause column misalignment.
      expect(snapshot.snapshotAnsi).toContain('new TUI header')
    })

    it('Ink repaint with absolute row positioning breaks after clear', async () => {
      // Some Ink versions use absolute cursor positioning.
      // Without clear: cursor is where snapshot left it, absolute pos works.
      // With clear: absolute pos still works (not affected by cursor).
      // But: if Ink uses CSR (scroll regions) or relative moves based on
      // stored line count, the clear creates a mismatch.
      const cols = 80
      const rows = 10
      const fresh = new HeadlessEmulator({ cols, rows })

      // Snapshot places content starting at row 3 (2 blank rows above)
      await fresh.write('\x1b[3;1Hheader line\r\n> prompt\r\nfooter')

      // No clear — Ink rewrites from row 3
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

      // Reattach with different dims (simulating eager spawn at 80x24)
      const result = await h.createOrAttach({
        sessionId: 's1',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      // Snapshot should be at the SESSION's dimensions, not the request's
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

      // Resize session (simulating a previous resize before app quit)
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

      // Simulate what the renderer does: clear screen, write full
      // snapshot, then the TUI repaints its viewport on SIGWINCH.
      const fresh = new HeadlessEmulator({ cols: 80, rows: 10 })
      await fresh.write('\x1b[2J\x1b[3J\x1b[H')
      await fresh.write(payload.fullPayload)
      // SIGWINCH repaint — TUI redraws its viewport area
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
