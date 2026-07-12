import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { HistoryManager } from './history-manager'
import { HistoryReader } from './history-reader'
import { HeadlessEmulator } from './headless-emulator'

// Reproduction for the "blank pane after agent hibernation" bug.
//
// Verified root cause (NOT the meta.endedAt gate — see below):
// Agent hibernation force-kills the agent PTY via the immediate path
// (pty:kill -> shutdown({ immediate: true, keepHistory: true }) ->
// TerminalHost.kill(immediate) -> forceKillAndDisposeSubprocess), which reaps
// synchronously WITHOUT firing onExit. So closeSession never runs and
// meta.endedAt stays null — detectColdRestore does NOT reject the session.
//
// The actual blank comes from cold-restore CONTENT, not eligibility:
// Claude/Codex TUIs run in terminal alternate-screen mode. For an alt-screen
// snapshot, HistoryReader.coldRestoreInfoFromSnapshot returns scrollbackAnsi=''
// (history-reader.ts:190-191), and DaemonPtyAdapter then skips the cold-restore
// payload entirely on `if (scrollback)` (daemon-pty-adapter.ts:230) — "no
// content is better than a confusing empty restore." Result: the daemon sends
// nothing back on wake and the preserved pane repaints blank, even though a
// full snapshotAnsi of the agent's last screen is intact on disk.
//
// This test drives a real HeadlessEmulator into alt-screen mode, checkpoints it
// through the real HistoryManager, and asserts the empty-scrollback outcome the
// adapter treats as "no cold restore".
//
// Scope note: this file documents the bug MECHANISM at the emulator/reader layer
// and replicates the adapter's payload decision inline, so its post-fix
// assertions would still pass if the production line were reverted. The actual
// regression guard that exercises DaemonPtyAdapter.spawn() end-to-end lives in
// daemon-pty-adapter.test.ts ("cold-restores an alt-screen agent snapshot…").

const ALT_SCREEN_ON = '\x1b[?1049h'

// Note: HistoryManager.checkpoint() takes the emulator's TerminalSnapshot directly
// and stamps generation / checkpointedAt itself, so em.getSnapshot() is passed as-is.

describe('agent hibernation cold-restore (alt-screen TUI)', () => {
  let dir: string
  const sessionId = 'repo-1::/Users/dev/pr-review-6321'

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hibernation-repro-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('a NORMAL-screen shell cold-restores its snapshot as scrollback (control)', async () => {
    const manager = new HistoryManager(dir)
    const reader = new HistoryReader(dir)
    const em = new HeadlessEmulator({ cols: 80, rows: 24 })
    em.writeSync('thebr@host:~/project$ echo hello\r\nhello\r\n')

    await manager.openSession(sessionId, { cwd: '/home/user/project', cols: 80, rows: 24 })
    await manager.checkpoint(sessionId, em.getSnapshot())
    em.dispose()

    const info = reader.detectColdRestore(sessionId)
    expect(info).not.toBeNull()
    // Adapter uses rehydrateSequences + snapshotAnsi for non-alt-screen → non-empty.
    expect(info!.modes.alternateScreen).toBe(false)
    // Normal-screen restores carry their buffer as scrollback; assert both so a
    // regression that empties scrollbackAnsi can't slip past this control.
    expect(info!.scrollbackAnsi).toContain('hello')
    expect(info!.snapshotAnsi).toContain('hello')
  })

  it('post-fix: an ALT-SCREEN TUI agent with empty scrollback now cold-restores its snapshot', async () => {
    const manager = new HistoryManager(dir)
    const reader = new HistoryReader(dir)
    const em = new HeadlessEmulator({ cols: 80, rows: 24 })
    // Why: Claude/Codex enter the alternate screen. Once in alt-screen, the
    // serialized snapshot is the TUI buffer and scrollbackAnsi is empty.
    em.writeSync(ALT_SCREEN_ON)
    em.writeSync('\x1b[2J\x1b[H Claude Code — Opus 4.8\r\n > ')
    expect(em.isAlternateScreen).toBe(true)

    await manager.openSession(sessionId, { cwd: '/home/user/project', cols: 80, rows: 24 })
    await manager.checkpoint(sessionId, em.getSnapshot())
    em.dispose()

    const info = reader.detectColdRestore(sessionId)
    // The session IS eligible (endedAt is null — hibernation's immediate kill
    // never stamps it), and the snapshot of the agent's screen is intact...
    expect(info).not.toBeNull()
    expect(info!.modes.alternateScreen).toBe(true)
    expect(info!.snapshotAnsi.length).toBeGreaterThan(0)

    // scrollbackAnsi is empty for alt-screen (the bug's trigger). Pre-fix the
    // adapter's `isAltScreen ? scrollbackAnsi || null : ...` dropped the
    // payload here, leaving the pane blank.
    expect(info!.scrollbackAnsi).toBe('')

    // Replicate the adapter's POST-FIX payload decision: alt-screen falls
    // back to snapshotAnsi (the agent's last frame) when scrollbackAnsi is
    // empty, so the pane is no longer blank on wake.
    const isAltScreen = info!.modes.alternateScreen
    const adapterScrollback = isAltScreen
      ? info!.scrollbackAnsi || info!.snapshotAnsi || null
      : info!.rehydrateSequences + info!.snapshotAnsi
    expect(adapterScrollback).not.toBeNull() // → adapter sends a coldRestore payload
    expect(adapterScrollback).toContain('Claude Code')
  })

  it('post-fix: the restored alt-screen snapshot lands at a NORMAL screen, not alt-screen', async () => {
    const manager = new HistoryManager(dir)
    const reader = new HistoryReader(dir)
    const em = new HeadlessEmulator({ cols: 80, rows: 24 })
    em.writeSync(ALT_SCREEN_ON)
    em.writeSync('\x1b[2J\x1b[H Claude Code — Opus 4.8\r\n > do something\r\n')

    await manager.openSession(sessionId, { cwd: '/home/user/project', cols: 80, rows: 24 })
    await manager.checkpoint(sessionId, em.getSnapshot())
    em.dispose()

    const info = reader.detectColdRestore(sessionId)
    const adapterScrollback = info!.modes.alternateScreen
      ? info!.scrollbackAnsi || info!.snapshotAnsi || null
      : info!.rehydrateSequences + info!.snapshotAnsi
    expect(adapterScrollback).not.toBeNull()

    // Drive the renderer's cold-restore branch into a FRESH shell emulator:
    // clear, write the payload, then POST_REPLAY_MODE_RESET. The pane must end
    // in the normal buffer (no \x1b[?1049h fed) so it won't fight the agent's
    // own repaint when the resume command relaunches it.
    // Keep in sync with POST_REPLAY_MODE_RESET in
    // src/renderer/src/components/terminal-pane/layout-serialization.ts (copied
    // as a literal because a main-process test must not import a renderer module).
    const POST_REPLAY_MODE_RESET =
      '\x1b[0 q\x1b[<99u\x1b[=0u\x1b[?25h\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1016l\x1b[?1004l\x1b[?2004l'
    const fresh = new HeadlessEmulator({ cols: 80, rows: 24 })
    fresh.writeSync('\x1b[2J\x1b[3J\x1b[H')
    fresh.writeSync(adapterScrollback as string)
    fresh.writeSync(POST_REPLAY_MODE_RESET)
    expect(fresh.isAlternateScreen).toBe(false)
    expect(fresh.getVisibleLines().some((l) => l.includes('Claude Code'))).toBe(true)
    fresh.dispose()
  })

  it('an alt-screen snapshot with no drawn content restores harmlessly (no alt-screen re-entry)', async () => {
    const manager = new HistoryManager(dir)
    const reader = new HistoryReader(dir)
    const em = new HeadlessEmulator({ cols: 80, rows: 24 })
    // Alt-screen entered but nothing drawn. SerializeAddon still emits a bare
    // cursor-home (\x1b[H), so the payload is non-null but visually empty —
    // safe to write into the fresh shell and crucially never re-enters
    // alt-screen (rehydrateSequences is omitted).
    em.writeSync(ALT_SCREEN_ON)

    await manager.openSession(sessionId, { cwd: '/home/user/project', cols: 80, rows: 24 })
    await manager.checkpoint(sessionId, em.getSnapshot())
    em.dispose()

    const info = reader.detectColdRestore(sessionId)
    expect(info!.modes.alternateScreen).toBe(true)
    const adapterScrollback = info!.scrollbackAnsi || info!.snapshotAnsi || null
    expect(adapterScrollback).not.toContain(ALT_SCREEN_ON)

    const fresh = new HeadlessEmulator({ cols: 80, rows: 24 })
    fresh.writeSync('\x1b[2J\x1b[3J\x1b[H')
    if (adapterScrollback) {
      fresh.writeSync(adapterScrollback)
    }
    expect(fresh.isAlternateScreen).toBe(false)
    fresh.dispose()
  })
})
