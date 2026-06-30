/**
 * Memory-leak regression: disabledSessions must not retain ids of sessions that
 * exited normally.
 *
 * `handleWriteError` adds a sessionId to the `disabledSessions` Set on any
 * best-effort history write failure (EIO/ENOSPC/EACCES). `closeSession` — the
 * NORMAL terminal-exit teardown — deleted the writer but never the disabled flag.
 * The only other delete sites are `openSession` (fires only on id reuse, which
 * never happens — sessionIds are fresh per PTY) and `removeSession` (explicit
 * user-kill). So a session that hit a transient write error mid-life then exited
 * normally left its sessionId in `disabledSessions` forever — one leaked id per
 * such session for the daemon's lifetime.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync, chmodSync } from 'node:fs'
import { HistoryManager } from './history-manager'
import type { TerminalSnapshot, TerminalModes } from './types'
import { getHistorySessionDirName } from './history-paths'

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), 'history-mgr-leak-test-'))
}

const defaultModes: TerminalModes = {
  bracketedPaste: false,
  mouseTracking: false,
  applicationCursor: false,
  alternateScreen: false
}

function makeSnapshot(): TerminalSnapshot {
  return {
    snapshotAnsi: 'hello\r\n',
    scrollbackAnsi: '',
    rehydrateSequences: '',
    cwd: '/tmp',
    modes: defaultModes,
    cols: 80,
    rows: 24,
    scrollbackLines: 0
  }
}

describe('HistoryManager disabledSessions stays bounded (leak regression)', () => {
  let dir: string
  let mgr: HistoryManager

  beforeEach(() => {
    dir = createTestDir()
    mgr = new HistoryManager(dir)
  })

  afterEach(async () => {
    await mgr.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  // Drive a session into the disabled set via a write error, then close it
  // normally — mirrors the chmod-based error injection in history-manager.test.ts.
  async function poisonThenCloseNormally(sessionId: string): Promise<void> {
    await mgr.openSession(sessionId, { cwd: '/tmp', cols: 80, rows: 24 })
    const sessionDir = join(dir, getHistorySessionDirName(sessionId))
    chmodSync(sessionDir, 0o555) // read-only -> checkpoint write fails -> disabled
    await mgr.checkpoint(sessionId, makeSnapshot())
    chmodSync(sessionDir, 0o755) // restore so endedAt write at close succeeds
    await mgr.closeSession(sessionId, 0)
  }

  it.skipIf(process.platform === 'win32')(
    'clears the disabled flag when a poisoned session exits normally',
    async () => {
      await poisonThenCloseNormally('sess-1')
      expect(mgr.isSessionDisabled('sess-1')).toBe(false)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'does not accumulate disabled ids across many poisoned-then-closed sessions',
    async () => {
      for (let i = 0; i < 50; i++) {
        await poisonThenCloseNormally(`sess-${i}`)
      }
      expect(mgr.disabledSessionCount()).toBe(0)
    }
  )
})
