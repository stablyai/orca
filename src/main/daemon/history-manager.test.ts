import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { HistoryManager } from './history-manager'
import { flushPendingSessionTreeRemovals } from './terminal-history-session-tombstone'
import type { TerminalSnapshot, TerminalModes } from './types'
import { getHistorySessionDirName } from './history-paths'
import {
  getTerminalHistoryQuarantineOwnerDir,
  hasTerminalHistoryRecoveryProtection
} from './terminal-history-recovery-quarantine'

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), 'history-mgr-test-'))
}

function sessionPath(baseDir: string, sessionId: string, file: string): string {
  return join(baseDir, getHistorySessionDirName(sessionId), file)
}

const defaultModes: TerminalModes = {
  bracketedPaste: false,
  mouseTracking: false,
  applicationCursor: false,
  alternateScreen: false
}

function makeSnapshot(overrides: Partial<TerminalSnapshot> = {}): TerminalSnapshot {
  return {
    snapshotAnsi: 'hello world\r\n',
    scrollbackAnsi: '',
    rehydrateSequences: '',
    cwd: '/tmp',
    modes: defaultModes,
    cols: 80,
    rows: 24,
    scrollbackLines: 0,
    ...overrides
  }
}

describe('HistoryManager', () => {
  let dir: string
  let mgr: HistoryManager

  beforeEach(() => {
    dir = createTestDir()
    mgr = new HistoryManager(dir)
  })

  afterEach(async () => {
    await mgr.dispose()
    // Detached tombstone reclaims outlive the test that queued them; settle before the fixture goes.
    await flushPendingSessionTreeRemovals()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('openSession', () => {
    it('creates meta.json with session metadata', async () => {
      await mgr.openSession('sess-1', { cwd: '/home/user', cols: 80, rows: 24 })

      const metaPath = sessionPath(dir, 'sess-1', 'meta.json')
      expect(existsSync(metaPath)).toBe(true)

      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
      expect(meta.cwd).toBe('/home/user')
      expect(meta.cols).toBe(80)
      expect(meta.rows).toBe(24)
      expect(meta.startedAt).toBeDefined()
      expect(meta.endedAt).toBeNull()
      expect(meta.exitCode).toBeNull()
    })

    it('creates session directory', async () => {
      await mgr.openSession('sess-1', { cwd: '/tmp', cols: 120, rows: 40 })

      const sessionDir = join(dir, getHistorySessionDirName('sess-1'))
      expect(existsSync(sessionDir)).toBe(true)
    })

    it('quarantines the complete unreadable generation before opening a replacement', async () => {
      const sessionId = 'unreadable-recovery'
      await mgr.openSession(sessionId, { cwd: '/old', cols: 80, rows: 24 })
      await mgr.checkpoint(sessionId, makeSnapshot({ snapshotAnsi: 'only recovery copy' }))
      writeFileSync(sessionPath(dir, sessionId, 'future-artifact'), 'keep me')
      const recoveryFreeze = await mgr.freezeForRecovery(sessionId)

      await mgr.openSession(sessionId, {
        cwd: '/new',
        cols: 120,
        rows: 40,
        recoveryFreeze,
        quarantineUnreadableRecovery: true
      })

      const ownerDir = getTerminalHistoryQuarantineOwnerDir(dir, sessionId)
      const bundles = readdirSync(ownerDir)
      expect(bundles).toHaveLength(1)
      const quarantined = join(ownerDir, bundles[0])
      expect(readdirSync(quarantined).sort()).toEqual([
        '.unreadable-recovery',
        'checkpoint.json',
        'future-artifact',
        'meta.json',
        'output.log'
      ])
      expect(readFileSync(join(quarantined, 'checkpoint.json'), 'utf8')).toContain(
        'only recovery copy'
      )
      expect(existsSync(sessionPath(dir, sessionId, 'checkpoint.json'))).toBe(false)
      expect(
        JSON.parse(readFileSync(sessionPath(dir, sessionId, 'meta.json'), 'utf8'))
      ).toMatchObject({
        cwd: '/new',
        cols: 120,
        rows: 40
      })
    })

    it('fails closed when the frozen recovery generation changes', async () => {
      const sessionId = 'changed-recovery'
      await mgr.openSession(sessionId, { cwd: '/old', cols: 80, rows: 24 })
      await mgr.checkpoint(sessionId, makeSnapshot())
      const recoveryFreeze = await mgr.freezeForRecovery(sessionId)
      writeFileSync(sessionPath(dir, sessionId, 'raced-artifact'), 'new generation')

      await mgr.openSession(sessionId, {
        cwd: '/new',
        cols: 80,
        rows: 24,
        recoveryFreeze,
        quarantineUnreadableRecovery: true
      })

      expect(mgr.isSessionDisabled(sessionId)).toBe(true)
      expect(existsSync(sessionPath(dir, sessionId, 'checkpoint.json'))).toBe(true)
      expect(existsSync(sessionPath(dir, sessionId, 'raced-artifact'))).toBe(true)
      expect(existsSync(getTerminalHistoryQuarantineOwnerDir(dir, sessionId))).toBe(false)
    })

    it('leaves persistent protection when the quarantine rename cannot start', async () => {
      const sessionId = 'blocked-quarantine'
      await mgr.openSession(sessionId, { cwd: '/old', cols: 80, rows: 24 })
      await mgr.checkpoint(sessionId, makeSnapshot())
      const recoveryFreeze = await mgr.freezeForRecovery(sessionId)
      writeFileSync(join(dir, '.recovery-quarantine'), 'block owner directory creation')

      await mgr.openSession(sessionId, {
        cwd: '/new',
        cols: 80,
        rows: 24,
        recoveryFreeze,
        quarantineUnreadableRecovery: true
      })

      expect(mgr.isSessionDisabled(sessionId)).toBe(true)
      expect(hasTerminalHistoryRecoveryProtection(dir, sessionId)).toBe(true)
      expect(existsSync(sessionPath(dir, sessionId, 'checkpoint.json'))).toBe(true)
    })

    it('rejects an unverified writer for a protected recovery generation', async () => {
      const sessionId = 'protected-register'
      await mgr.openSession(sessionId, { cwd: '/old', cols: 80, rows: 24 })
      const recoveryFreeze = await mgr.freezeForRecovery(sessionId)
      writeFileSync(join(dir, '.recovery-quarantine'), 'block owner directory creation')
      await mgr.openSession(sessionId, {
        cwd: '/new',
        cols: 80,
        rows: 24,
        recoveryFreeze,
        quarantineUnreadableRecovery: true
      })
      const relaunched = new HistoryManager(dir)

      relaunched.registerWriter(sessionId)

      expect(relaunched.isSessionDisabled(sessionId)).toBe(true)
      expect(relaunched.hasWriter(sessionId)).toBe(false)
    })

    it('rejects a freeze-verified writer for a protected recovery generation', async () => {
      const sessionId = 'recovered-protection'
      await mgr.openSession(sessionId, { cwd: '/old', cols: 80, rows: 24 })
      const recoveryFreeze = await mgr.freezeForRecovery(sessionId)
      writeFileSync(join(dir, '.recovery-quarantine'), 'block owner directory creation')
      await mgr.openSession(sessionId, {
        cwd: '/new',
        cols: 80,
        rows: 24,
        recoveryFreeze,
        quarantineUnreadableRecovery: true
      })
      const relaunched = new HistoryManager(dir)
      const verifiedFreeze = await relaunched.freezeForRecovery(sessionId)
      relaunched.registerWriter(sessionId, verifiedFreeze)

      await relaunched.checkpoint(sessionId, makeSnapshot({ snapshotAnsi: 'verified recovery' }))

      expect(hasTerminalHistoryRecoveryProtection(dir, sessionId)).toBe(true)
      expect(relaunched.hasWriter(sessionId)).toBe(false)
      expect(relaunched.isSessionDisabled(sessionId)).toBe(true)
    })

    it('rejects a consumed recovery freeze token', async () => {
      const sessionId = 'consumed-freeze'
      await mgr.openSession(sessionId, { cwd: '/old', cols: 80, rows: 24 })
      const recoveryFreeze = await mgr.freezeForRecovery(sessionId)
      await mgr.openSession(sessionId, {
        cwd: '/new',
        cols: 80,
        rows: 24,
        recoveryFreeze
      })
      mgr.suspendSession(sessionId)

      mgr.registerWriter(sessionId, recoveryFreeze)

      expect(mgr.isSessionDisabled(sessionId)).toBe(true)
    })
  })

  describe('incognito ("no-session") sessions', () => {
    it('writes no session directory, output.log or checkpoint.json for an incognito session', async () => {
      const sessionId = 'incognito-1'
      await mgr.openSession(sessionId, { cwd: '/home/user', cols: 80, rows: 24, incognito: true })
      // Increments and a checkpoint must be silently dropped, not persisted.
      await mgr.appendIncrements(sessionId, 1, [{ kind: 'output', data: 'secret output\r\n' }])
      await mgr.checkpoint(sessionId, makeSnapshot({ snapshotAnsi: 'secret output\r\n' }))

      const sessionDir = join(dir, getHistorySessionDirName(sessionId))
      expect(existsSync(sessionDir)).toBe(false)
      expect(existsSync(sessionPath(dir, sessionId, 'meta.json'))).toBe(false)
      expect(existsSync(sessionPath(dir, sessionId, 'output.log'))).toBe(false)
      expect(existsSync(sessionPath(dir, sessionId, 'checkpoint.json'))).toBe(false)
      expect(mgr.hasWriter(sessionId)).toBe(false)
    })

    it('records a normal session in the same manager (control)', async () => {
      await mgr.openSession('normal-1', { cwd: '/tmp', cols: 80, rows: 24 })
      await mgr.checkpoint('normal-1', makeSnapshot({ snapshotAnsi: 'recorded\r\n' }))

      expect(existsSync(sessionPath(dir, 'normal-1', 'meta.json'))).toBe(true)
      expect(existsSync(sessionPath(dir, 'normal-1', 'checkpoint.json'))).toBe(true)
      expect(mgr.hasWriter('normal-1')).toBe(true)
    })

    it('keeps registerWriter and reopenSession no-ops for an incognito session (warm reattach / wake)', async () => {
      const sessionId = 'incognito-reattach'
      await mgr.openSession(sessionId, { cwd: '/tmp', cols: 80, rows: 24, incognito: true })

      mgr.registerWriter(sessionId)
      mgr.reopenSession(sessionId)

      expect(mgr.hasWriter(sessionId)).toBe(false)
      expect(existsSync(join(dir, getHistorySessionDirName(sessionId)))).toBe(false)
    })

    it('surfaces a ledger persistence failure instead of silently continuing without restart suppression', async () => {
      // The durable ledger is the ONLY thing that keeps this session incognito across a restart. If
      // it cannot be written, a later daemon can re-adopt the id without the flag and start recording,
      // so a swallowed write must become a loud write-error — not a false success.
      const failDir = createTestDir()
      // Force the ledger's tmp+rename write to fail in a way a privileged (root) runner cannot
      // bypass: directory modes are ignored under CAP_DAC_OVERRIDE, but writing a FILE to a path
      // that is already a DIRECTORY always throws EISDIR. The ledger writes `<path>.tmp` first.
      mkdirSync(join(failDir, '.incognito-sessions.json.tmp'))
      const writeErrors: [string, Error][] = []
      const onWriteError = (sessionId: string, error: Error): void => {
        writeErrors.push([sessionId, error])
      }
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const failing = new HistoryManager(failDir, { onWriteError })
      try {
        await failing.openSession('incognito-nodurable', {
          cwd: '/tmp',
          cols: 80,
          rows: 24,
          incognito: true
        })

        expect(writeErrors).toHaveLength(1)
        expect(writeErrors[0][0]).toBe('incognito-nodurable')
        // Surfaced loudly even though a callback happens to be wired here — production has none.
        expect(errorSpy).toHaveBeenCalled()
        // The session is disabled for this process too, so even in-memory appends stay no-ops.
        expect(failing.isSessionDisabled('incognito-nodurable')).toBe(true)
        // No writer/dir was created, and the (unwritable) ledger file did not appear.
        expect(failing.hasWriter('incognito-nodurable')).toBe(false)
        expect(existsSync(join(failDir, '.incognito-sessions.json'))).toBe(false)
      } finally {
        errorSpy.mockRestore()
        await failing.dispose()
        rmSync(failDir, { recursive: true, force: true })
      }
    })

    it('fails CLOSED on re-adopt when the ledger is untrusted, but still records a fresh normal session', async () => {
      // Corrupt ledger → its do-not-record ids are lost. A re-adopt (no explicit flag) might be one of
      // them, so it must NOT be recorded; a brand-new, explicitly non-incognito session still records.
      const failDir = createTestDir()
      writeFileSync(join(failDir, '.incognito-sessions.json'), '{ corrupt')
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const mgrUntrusted = new HistoryManager(failDir)
      try {
        // Re-adopt path: openSession with no incognito flag, and warm-reattach registerWriter.
        await mgrUntrusted.openSession('readopt-unknown', { cwd: '/tmp', cols: 80, rows: 24 })
        mgrUntrusted.registerWriter('reattach-unknown')
        expect(mgrUntrusted.hasWriter('readopt-unknown')).toBe(false)
        expect(mgrUntrusted.hasWriter('reattach-unknown')).toBe(false)
        expect(existsSync(join(failDir, getHistorySessionDirName('readopt-unknown')))).toBe(false)

        // A brand-new session explicitly created non-incognito is known provenance → records normally.
        await mgrUntrusted.openSession('fresh-normal', {
          cwd: '/tmp',
          cols: 80,
          rows: 24,
          incognito: false
        })
        expect(mgrUntrusted.hasWriter('fresh-normal')).toBe(true)
      } finally {
        errorSpy.mockRestore()
        await mgrUntrusted.dispose()
        rmSync(failDir, { recursive: true, force: true })
      }
    })

    it('stays incognito across a restart: a fresh manager on the same dir records nothing on re-adopt', async () => {
      const sessionId = 'incognito-persist'
      await mgr.openSession(sessionId, { cwd: '/tmp', cols: 80, rows: 24, incognito: true })

      // A daemon/app restart: a brand-new HistoryManager over the same base dir re-adopts the session
      // (openSession/registerWriter WITHOUT the incognito flag). It must still write nothing.
      const relaunched = new HistoryManager(dir)
      await relaunched.openSession(sessionId, { cwd: '/tmp', cols: 80, rows: 24 })
      relaunched.registerWriter(sessionId)
      await relaunched.checkpoint(sessionId, makeSnapshot({ snapshotAnsi: 'post-restart\r\n' }))

      expect(existsSync(join(dir, getHistorySessionDirName(sessionId)))).toBe(false)
      expect(relaunched.hasWriter(sessionId)).toBe(false)
      await relaunched.dispose()
    })
  })

  describe('checkpoint', () => {
    it('writes checkpoint.json with snapshot data', async () => {
      await mgr.openSession('sess-1', { cwd: '/tmp', cols: 80, rows: 24 })

      const snapshot = makeSnapshot({ snapshotAnsi: 'terminal content\r\n' })
      await mgr.checkpoint('sess-1', snapshot)

      const cpPath = sessionPath(dir, 'sess-1', 'checkpoint.json')
      expect(existsSync(cpPath)).toBe(true)

      const data = JSON.parse(readFileSync(cpPath, 'utf-8'))
      expect(data.snapshotAnsi).toBe('terminal content\r\n')
      expect(data.cols).toBe(80)
      expect(data.rows).toBe(24)
      expect(data.checkpointedAt).toBeDefined()
    })

    it('overwrites previous checkpoint atomically', async () => {
      await mgr.openSession('sess-1', { cwd: '/tmp', cols: 80, rows: 24 })

      await mgr.checkpoint('sess-1', makeSnapshot({ snapshotAnsi: 'first' }))
      await mgr.checkpoint('sess-1', makeSnapshot({ snapshotAnsi: 'second' }))

      const data = JSON.parse(readFileSync(sessionPath(dir, 'sess-1', 'checkpoint.json'), 'utf-8'))
      expect(data.snapshotAnsi).toBe('second')
    })

    it('preserves terminal modes in checkpoint', async () => {
      await mgr.openSession('sess-1', { cwd: '/tmp', cols: 80, rows: 24 })

      const modes: TerminalModes = {
        bracketedPaste: true,
        mouseTracking: false,
        applicationCursor: true,
        alternateScreen: false
      }
      await mgr.checkpoint('sess-1', makeSnapshot({ modes }))

      const data = JSON.parse(readFileSync(sessionPath(dir, 'sess-1', 'checkpoint.json'), 'utf-8'))
      expect(data.modes.bracketedPaste).toBe(true)
      expect(data.modes.applicationCursor).toBe(true)
    })

    it('preserves rehydrateSequences in checkpoint', async () => {
      await mgr.openSession('sess-1', { cwd: '/tmp', cols: 80, rows: 24 })

      await mgr.checkpoint('sess-1', makeSnapshot({ rehydrateSequences: '\x1b[?2004h\x1b[?1h' }))

      const data = JSON.parse(readFileSync(sessionPath(dir, 'sess-1', 'checkpoint.json'), 'utf-8'))
      expect(data.rehydrateSequences).toBe('\x1b[?2004h\x1b[?1h')
    })

    it('preserves OSC link ranges in checkpoint', async () => {
      await mgr.openSession('sess-1', { cwd: '/tmp', cols: 80, rows: 24 })
      const oscLinks = [{ row: 0, startCol: 6, endCol: 11, uri: 'https://example.com/issue/1234' }]

      await mgr.checkpoint('sess-1', makeSnapshot({ oscLinks }))

      const data = JSON.parse(readFileSync(sessionPath(dir, 'sess-1', 'checkpoint.json'), 'utf-8'))
      expect(data.oscLinks).toEqual(oscLinks)
    })

    it('ignores checkpoint for unknown sessions', async () => {
      await mgr.checkpoint('nonexistent', makeSnapshot())
    })

    it.skipIf(process.platform === 'win32')(
      'ignores checkpoint for disabled sessions',
      async () => {
        await mgr.openSession('sess-1', { cwd: '/tmp', cols: 80, rows: 24 })

        const cpPath = sessionPath(dir, 'sess-1', 'checkpoint.json')
        chmodSync(join(dir, getHistorySessionDirName('sess-1')), 0o555)

        await mgr.checkpoint('sess-1', makeSnapshot())

        chmodSync(join(dir, getHistorySessionDirName('sess-1')), 0o755)

        await mgr.checkpoint('sess-1', makeSnapshot({ snapshotAnsi: 'after-error' }))
        expect(existsSync(cpPath)).toBe(false)
      }
    )

    it('does not write scrollback.bin', async () => {
      await mgr.openSession('sess-1', { cwd: '/tmp', cols: 80, rows: 24 })
      await mgr.checkpoint('sess-1', makeSnapshot())

      expect(existsSync(sessionPath(dir, 'sess-1', 'scrollback.bin'))).toBe(false)
    })
  })

  describe('closeSession', () => {
    it('writes endedAt and exitCode to meta.json', async () => {
      await mgr.openSession('sess-1', { cwd: '/tmp', cols: 80, rows: 24 })
      await mgr.closeSession('sess-1', 0)

      const meta = JSON.parse(readFileSync(sessionPath(dir, 'sess-1', 'meta.json'), 'utf-8'))
      expect(meta.endedAt).toBeDefined()
      expect(meta.exitCode).toBe(0)
    })

    it('ignores close for unknown sessions', async () => {
      await mgr.closeSession('nonexistent', 0)
    })
  })

  describe('multiple sessions', () => {
    it('manages independent sessions', async () => {
      await mgr.openSession('a', { cwd: '/a', cols: 80, rows: 24 })
      await mgr.openSession('b', { cwd: '/b', cols: 120, rows: 40 })

      await mgr.checkpoint('a', makeSnapshot({ snapshotAnsi: 'session-a' }))
      await mgr.checkpoint('b', makeSnapshot({ snapshotAnsi: 'session-b' }))

      const dataA = JSON.parse(readFileSync(sessionPath(dir, 'a', 'checkpoint.json'), 'utf-8'))
      const dataB = JSON.parse(readFileSync(sessionPath(dir, 'b', 'checkpoint.json'), 'utf-8'))

      expect(dataA.snapshotAnsi).toBe('session-a')
      expect(dataB.snapshotAnsi).toBe('session-b')
    })
  })

  describe('dispose', () => {
    it('writes endedAt for open sessions to prevent false cold-restore', async () => {
      await mgr.openSession('sess-1', { cwd: '/tmp', cols: 80, rows: 24 })
      await mgr.checkpoint('sess-1', makeSnapshot())
      await mgr.dispose()

      const meta = JSON.parse(readFileSync(sessionPath(dir, 'sess-1', 'meta.json'), 'utf-8'))
      expect(meta.endedAt).not.toBeNull()
      expect(meta.exitCode).toBeNull()
    })
  })

  describe('removeSession', () => {
    it('deletes session directory from disk', async () => {
      await mgr.openSession('sess-1', { cwd: '/tmp', cols: 80, rows: 24 })
      await mgr.checkpoint('sess-1', makeSnapshot())
      await mgr.closeSession('sess-1', 0)

      await mgr.removeSession('sess-1')
      expect(existsSync(join(dir, getHistorySessionDirName('sess-1')))).toBe(false)
    })

    it('deletes quarantined recovery owned by the session', async () => {
      const sessionId = 'remove-quarantine'
      await mgr.openSession(sessionId, { cwd: '/tmp', cols: 80, rows: 24 })
      const recoveryFreeze = await mgr.freezeForRecovery(sessionId)
      await mgr.openSession(sessionId, {
        cwd: '/new',
        cols: 80,
        rows: 24,
        recoveryFreeze,
        quarantineUnreadableRecovery: true
      })
      const ownerDir = getTerminalHistoryQuarantineOwnerDir(dir, sessionId)
      expect(existsSync(ownerDir)).toBe(true)

      await mgr.removeSession(sessionId)

      expect(existsSync(ownerDir)).toBe(false)
      expect(existsSync(join(dir, getHistorySessionDirName(sessionId)))).toBe(false)
    })
  })

  describe('hasHistory', () => {
    it('returns true for sessions with meta.json on disk', async () => {
      await mgr.openSession('sess-1', { cwd: '/tmp', cols: 80, rows: 24 })
      await mgr.closeSession('sess-1', 0)

      expect(mgr.hasHistory('sess-1')).toBe(true)
    })

    it('returns false for unknown sessions', () => {
      expect(mgr.hasHistory('nonexistent')).toBe(false)
    })
  })

  describe('readMeta', () => {
    it('reads meta.json for a session', async () => {
      await mgr.openSession('sess-1', { cwd: '/projects', cols: 100, rows: 30 })
      await mgr.closeSession('sess-1', 42)

      const meta = mgr.readMeta('sess-1')
      expect(meta).not.toBeNull()
      expect(meta!.cwd).toBe('/projects')
      expect(meta!.exitCode).toBe(42)
    })

    it('returns null for missing sessions', () => {
      expect(mgr.readMeta('nonexistent')).toBeNull()
    })
  })

  describe('error handling', () => {
    it.skipIf(process.platform === 'win32')(
      'disables writes after fs error and does not throw',
      async () => {
        await mgr.openSession('disk-full', { cwd: '/tmp', cols: 80, rows: 24 })

        const sessionDir = join(dir, getHistorySessionDirName('disk-full'))
        chmodSync(sessionDir, 0o555)

        await mgr.checkpoint('disk-full', makeSnapshot())

        chmodSync(sessionDir, 0o755)

        await mgr.checkpoint('disk-full', makeSnapshot({ snapshotAnsi: 'after-error' }))
        expect(existsSync(sessionPath(dir, 'disk-full', 'checkpoint.json'))).toBe(false)
      }
    )

    it.skipIf(process.platform === 'win32')(
      'disables writes after fs error on openSession',
      async () => {
        chmodSync(dir, 0o555)

        await mgr.openSession('disk-full-open', { cwd: '/tmp', cols: 80, rows: 24 })

        chmodSync(dir, 0o755)

        await mgr.checkpoint('disk-full-open', makeSnapshot())
      }
    )

    it.skipIf(process.platform === 'win32')(
      'does not throw on closeSession disk error',
      async () => {
        await mgr.openSession('close-err', { cwd: '/tmp', cols: 80, rows: 24 })

        const metaPath = sessionPath(dir, 'close-err', 'meta.json')
        chmodSync(metaPath, 0o444)

        await mgr.closeSession('close-err', 0)

        chmodSync(metaPath, 0o644)
      }
    )

    it.skipIf(process.platform === 'win32')(
      'reports write errors via onWriteError callback',
      async () => {
        const errors: { sessionId: string; error: Error }[] = []
        mgr = new HistoryManager(dir, {
          onWriteError: (sessionId, error) => errors.push({ sessionId, error })
        })

        await mgr.openSession('err-cb', { cwd: '/tmp', cols: 80, rows: 24 })

        const sessionDir = join(dir, getHistorySessionDirName('err-cb'))
        chmodSync(sessionDir, 0o555)

        await mgr.checkpoint('err-cb', makeSnapshot())

        chmodSync(sessionDir, 0o755)

        expect(errors).toHaveLength(1)
        expect(errors[0].sessionId).toBe('err-cb')
      }
    )
  })

  describe('large session cleanup responsiveness', () => {
    it('tombstones a large session tree instead of walking it on the teardown path', async () => {
      const sessionId = 'bulky'
      await mgr.openSession(sessionId, { cwd: '/tmp', cols: 80, rows: 24 })
      const sessionDir = join(dir, getHistorySessionDirName(sessionId))
      // Enough entries that a recursive walk would dominate removeSession's duration.
      for (let i = 0; i < 3_000; i++) {
        writeFileSync(join(sessionDir, `chunk-${i}.log`), `payload-${i}`)
      }

      // Why structural and not a turn count: worktree teardown awaits removeSession once per terminal,
      // so the contract is that the awaited half only renames. The tree surviving under .pending-delete
      // right after the await can only happen if the reclaim was detached.
      await mgr.removeSession(sessionId)

      expect(existsSync(sessionDir)).toBe(false)
      const tombstones = readdirSync(join(dir, '.pending-delete'))
      expect(tombstones).toHaveLength(1)
      expect(readdirSync(join(dir, '.pending-delete', tombstones[0])).length).toBeGreaterThan(0)

      await flushPendingSessionTreeRemovals()
      expect(readdirSync(join(dir, '.pending-delete'))).toHaveLength(0)
    })

    it('reclaims tombstones left by a quit mid-removal on the next construction', async () => {
      const sessionId = 'leftover'
      await mgr.openSession(sessionId, { cwd: '/tmp', cols: 80, rows: 24 })
      await mgr.removeSession(sessionId)
      await flushPendingSessionTreeRemovals()

      const orphan = join(dir, '.pending-delete', 'orphaned-tombstone')
      mkdirSync(orphan, { recursive: true })
      writeFileSync(join(orphan, 'output.log'), 'stranded')

      new HistoryManager(dir)
      await flushPendingSessionTreeRemovals()

      expect(existsSync(orphan)).toBe(false)
    })
  })
})
