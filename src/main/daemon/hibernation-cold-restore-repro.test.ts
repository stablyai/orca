import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { HistoryManager } from './history-manager'
import { HistoryReader } from './history-reader'
import { HeadlessEmulator } from './headless-emulator'
import { POST_REPLAY_MODE_RESET } from '../../shared/terminal-mode-reset-profiles'

// This inlines the restore decision; adapter tests separately guard the production path.

const ALT_SCREEN_ON = '\x1b[?1049h'

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
    expect(info!.modes.alternateScreen).toBe(false)
    expect(info!.scrollbackAnsi).toContain('hello')
    expect(info!.snapshotAnsi).toContain('hello')
  })

  it('post-fix: an ALT-SCREEN TUI agent with empty scrollback now cold-restores its snapshot', async () => {
    const manager = new HistoryManager(dir)
    const reader = new HistoryReader(dir)
    const em = new HeadlessEmulator({ cols: 80, rows: 24 })
    em.writeSync(ALT_SCREEN_ON)
    em.writeSync('\x1b[2J\x1b[H Claude Code — Opus 4.8\r\n > ')
    expect(em.isAlternateScreen).toBe(true)

    await manager.openSession(sessionId, { cwd: '/home/user/project', cols: 80, rows: 24 })
    await manager.checkpoint(sessionId, em.getSnapshot())
    em.dispose()

    const info = await reader.detectColdRestore(sessionId)
    expect(info).not.toBeNull()
    expect(info!.modes.alternateScreen).toBe(true)
    expect(info!.snapshotAnsi.length).toBeGreaterThan(0)

    // Empty alternate-screen scrollback must not suppress the intact snapshot.
    expect(info!.scrollbackAnsi).toBe('')

    const isAltScreen = info!.modes.alternateScreen
    const adapterScrollback = isAltScreen
      ? info!.scrollbackAnsi || info!.snapshotAnsi || null
      : info!.rehydrateSequences + info!.snapshotAnsi
    expect(adapterScrollback).not.toBeNull()
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

    // Return to the normal buffer so restoration cannot fight the resumed agent’s repaint.
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
