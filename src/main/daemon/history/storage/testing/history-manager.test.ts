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
  writeFileSync,
  promises as fsPromises
} from 'node:fs'
import { HistoryManager } from '../history-manager'
import * as hostTreeRemoval from '../../../../filesystem/host-tree-removal'
import { flushPendingSessionTreeRemovals } from '../terminal-history-session-tombstone'
import type { TerminalSnapshot } from '../../../protocol/terminal-snapshot'
import type { TerminalModes } from '../../../protocol/terminal-modes'
import { getHistorySessionDirName } from '../history-paths'
import {
  getTerminalHistoryQuarantineOwnerDir,
  hasTerminalHistoryRecoveryProtection
} from '../terminal-history-recovery-quarantine'

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

  describe('writer handoff', () => {
    it('leaves a successor and other live sessions intact when the predecessor closes late', async () => {
      const id = 'handoff'
      await mgr.openSession(id, { cwd: '/tmp', cols: 80, rows: 24 })
      await mgr.openSession('other-live', { cwd: '/tmp', cols: 80, rows: 24 })
      const successor = new HistoryManager(dir)
      try {
        const admission = successor.admit(id)
        await admission.ready
        await successor.openSession(id, { cwd: '/next', cols: 80, rows: 24, admission })
        await successor.checkpoint(id, makeSnapshot({ snapshotAnsi: 'SUCCESSOR\r\n' }))

        expect(await mgr.checkpoint(id, makeSnapshot({ snapshotAnsi: 'STALE\r\n' }))).toBe(
          'unavailable'
        )
        await mgr.closeSession(id, 0)
        await mgr.removeSession(id)
        expect(await mgr.checkpoint('other-live', makeSnapshot())).toBe('committed')
        await mgr.dispose()

        const meta = JSON.parse(readFileSync(sessionPath(dir, id, 'meta.json'), 'utf-8'))
        expect(meta.endedAt).toBeNull()
        expect(meta.cwd).toBe('/next')
        expect(readFileSync(sessionPath(dir, id, 'checkpoint.json'), 'utf-8')).toContain(
          'SUCCESSOR'
        )
      } finally {
        await successor.dispose()
      }
    })

    it('installs a successor only after issued predecessor writes actually settle', async () => {
      const id = 'stalled'
      await mgr.openSession(id, { cwd: '/tmp', cols: 80, rows: 24 })
      const releaseRename = Promise.withResolvers<void>()
      const rename = fsPromises.rename
      const stalled = vi.spyOn(fsPromises, 'rename').mockImplementationOnce(async (...args) => {
        await releaseRename.promise
        return rename(...args)
      })
      const predecessorWrite = mgr.checkpoint(id, makeSnapshot({ snapshotAnsi: 'OLD\r\n' }))
      await vi.waitFor(() => expect(stalled).toHaveBeenCalled())
      const successor = new HistoryManager(dir)
      try {
        const admission = successor.admit(id)
        // The caller does not wait on the fence; the install itself must refuse.
        await successor.openSession(id, { cwd: '/next', cols: 80, rows: 24, admission })
        expect(JSON.parse(readFileSync(sessionPath(dir, id, 'meta.json'), 'utf-8')).cwd).toBe(
          '/tmp'
        )

        releaseRename.resolve()
        await predecessorWrite
        await admission.ready
        await successor.openSession(id, { cwd: '/next', cols: 80, rows: 24, admission })
        const meta = JSON.parse(readFileSync(sessionPath(dir, id, 'meta.json'), 'utf-8'))
        expect(meta.cwd).toBe('/next')
        expect(existsSync(sessionPath(dir, id, 'checkpoint.json'))).toBe(false)
      } finally {
        await successor.dispose()
      }
    })
  })

  // CJ5: every normally exited ID used to keep its claim until the whole manager retired.
  it('releases an exited session for another owner while a live one stays claimed', async () => {
    await mgr.openSession('exited', { cwd: '/tmp', cols: 80, rows: 24 })
    await mgr.openSession('live', { cwd: '/tmp', cols: 80, rows: 24 })
    await mgr.closeSession('exited', 0)
    const other = new HistoryManager(dir)
    try {
      await other.removeSession('exited')
      await other.removeSession('live')
      expect(existsSync(join(dir, getHistorySessionDirName('exited')))).toBe(false)
      expect(existsSync(sessionPath(dir, 'live', 'meta.json'))).toBe(true)
      expect(await mgr.checkpoint('live', makeSnapshot())).toBe('committed')
    } finally {
      await other.dispose()
    }
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

      // Hold reclamation so the worker cannot delete the tombstone between assertions.
      const reclaim = Promise.withResolvers<void>()
      const removeHostTree = hostTreeRemoval.removeHostTree
      const removalSpy = vi
        .spyOn(hostTreeRemoval, 'removeHostTree')
        .mockImplementationOnce(async (tombstonePath) => {
          await reclaim.promise
          await removeHostTree(tombstonePath)
        })
      let removalReturned = false
      const removal = mgr.removeSession(sessionId).then(() => {
        removalReturned = true
      })
      try {
        await vi.waitFor(() => expect(removalReturned).toBe(true))
        expect(existsSync(sessionDir)).toBe(false)
        const tombstones = readdirSync(join(dir, '.pending-delete'))
        expect(tombstones).toHaveLength(1)
        const tombstonePath = join(dir, '.pending-delete', tombstones[0])
        expect(removalSpy).toHaveBeenCalledExactlyOnceWith(tombstonePath)
        expect(readdirSync(tombstonePath).length).toBeGreaterThan(0)
      } finally {
        reclaim.resolve()
        removalSpy.mockRestore()
        await removal
        await flushPendingSessionTreeRemovals()
      }
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
