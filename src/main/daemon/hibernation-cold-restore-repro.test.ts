import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { HistoryManager } from './history-manager'
import { HistoryReader } from './history-reader'
import { HeadlessEmulator } from './headless-emulator'

// Reproduces the "blank pane after agent hibernation" bug: alt-screen TUI snapshots have scrollbackAnsi='', so the adapter's
// `if (scrollback)` gate (daemon-pty-adapter.ts:230) dropped the cold-restore payload and repainted blank despite an intact snapshotAnsi.
// Not the meta.endedAt gate: hibernation's immediate kill never fires onExit, so endedAt stays null (session not rejected).
// This test inlines the adapter's decision, so it'd pass even if the fix were reverted; the real end-to-end guard is daemon-pty-adapter.test.ts.

const ALT_SCREEN_ON = '\x1b[?1049h'

// Note: checkpoint() stamps generation/checkpointedAt itself, so em.getSnapshot() is passed as-is.

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

    const info = await reader.detectColdRestore(sessionId)
    expect(info).not.toBeNull()
    // Adapter uses rehydrateSequences + snapshotAnsi for non-alt-screen → non-empty.
    expect(info!.modes.alternateScreen).toBe(false)
    // Normal-screen restores carry their buffer as scrollback; assert both so a regression emptying scrollbackAnsi can't slip past.
    expect(info!.scrollbackAnsi).toContain('hello')
    expect(info!.snapshotAnsi).toContain('hello')
  })

  it('post-fix: an ALT-SCREEN TUI agent with empty scrollback now cold-restores its snapshot', async () => {
    const manager = new HistoryManager(dir)
    const reader = new HistoryReader(dir)
    const em = new HeadlessEmulator({ cols: 80, rows: 24 })
    // Why: in alt-screen (Claude/Codex TUIs) the serialized snapshot is the TUI buffer and scrollbackAnsi is empty.
    em.writeSync(ALT_SCREEN_ON)
    em.writeSync('\x1b[2J\x1b[H Claude Code — Opus 4.8\r\n > ')
    expect(em.isAlternateScreen).toBe(true)

    await manager.openSession(sessionId, { cwd: '/home/user/project', cols: 80, rows: 24 })
    await manager.checkpoint(sessionId, em.getSnapshot())
    em.dispose()

    const info = await reader.detectColdRestore(sessionId)
    // Session is eligible (endedAt null) and the agent's snapshot is intact.
    expect(info).not.toBeNull()
    expect(info!.modes.alternateScreen).toBe(true)
    expect(info!.snapshotAnsi.length).toBeGreaterThan(0)

    // scrollbackAnsi is empty for alt-screen — the bug's trigger; pre-fix the adapter dropped the payload here, leaving the pane blank.
    expect(info!.scrollbackAnsi).toBe('')

    // Replicate the adapter's post-fix decision: alt-screen falls back to snapshotAnsi when scrollbackAnsi is empty, so the pane isn't blank.
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

    const info = await reader.detectColdRestore(sessionId)
    const adapterScrollback = info!.modes.alternateScreen
      ? info!.scrollbackAnsi || info!.snapshotAnsi || null
      : info!.rehydrateSequences + info!.snapshotAnsi
    expect(adapterScrollback).not.toBeNull()

    // Must end in the normal buffer (no alt-screen re-entry) so it won't fight the agent's own repaint when resume relaunches it.
    // POST_REPLAY_MODE_RESET copied literally from renderer layout-serialization.ts (main-process test can't import renderer) — keep in sync.
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
    // Alt-screen but nothing drawn: SerializeAddon emits only a bare cursor-home, so the payload never re-enters alt-screen.
    em.writeSync(ALT_SCREEN_ON)

    await manager.openSession(sessionId, { cwd: '/home/user/project', cols: 80, rows: 24 })
    await manager.checkpoint(sessionId, em.getSnapshot())
    em.dispose()

    const info = await reader.detectColdRestore(sessionId)
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
