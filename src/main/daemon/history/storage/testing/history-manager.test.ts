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
import { HistoryManager } from '../history-manager'
import { HistoryReader } from '../../restoration/history-reader'
import * as hostTreeRemoval from '../../../../filesystem/host-tree-removal'
import { flushPendingSessionTreeRemovals } from '../terminal-history-session-tombstone'
import type { TerminalSnapshot } from '../../../protocol/terminal-snapshot'
import type { TerminalModes } from '../../../protocol/terminal-modes'
import { getHistorySessionDirName } from '../history-paths'
import {
  getTerminalHistoryQuarantineOwnerDir,
  hasTerminalHistoryRecoveryProtection
} from '../terminal-history-recovery-quarantine'
import { updateTerminalHistoryProbedCwd } from '../terminal-history-metadata'

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

  describe('session cleanup', () => {
    it('tombstones a session tree and finishes teardown before reclamation', async () => {
      const sessionId = 'bulky'
      await mgr.openSession(sessionId, { cwd: '/tmp', cols: 80, rows: 24 })
      const sessionDir = join(dir, getHistorySessionDirName(sessionId))
      writeFileSync(join(sessionDir, 'output.log'), 'payload')

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
        expect(readFileSync(join(tombstonePath, 'output.log'), 'utf8')).toBe('payload')
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

  describe('probed cwd cold restore', () => {
    it('restores last probed cwd without OSC 7 across incremental logs, checkpoints, and cd back to spawn', async () => {
      const sessionId = 'no-osc7-cwd'
      const reader = new HistoryReader(dir)
      await mgr.openSession(sessionId, { cwd: '/alpha', cols: 80, rows: 24 })
      await mgr.appendIncrements(sessionId, 1, [{ kind: 'output', data: 'cd src/deep\r\n$ ' }])
      await mgr.recordProbedCwd(sessionId, '/alpha/src/deep')

      const afterIncrement = await reader.detectColdRestoreState(sessionId)
      expect(afterIncrement.status).toBe('restored')
      if (afterIncrement.status === 'restored') {
        expect(afterIncrement.restoreInfo.cwd).toBe('/alpha/src/deep')
        expect(afterIncrement.cwdFromSpawn).toBeUndefined()
      }

      // Full checkpoint persists the probed cwd and clears the pending override.
      await mgr.checkpoint(sessionId, makeSnapshot({ cwd: null }), { pendingOutputSeq: 1 })
      // Returning to the spawn dir after a checkpoint must override checkpoint.cwd.
      await mgr.appendIncrements(sessionId, 2, [{ kind: 'output', data: 'cd /alpha\r\n$ ' }])
      await mgr.recordProbedCwd(sessionId, '/alpha')

      const afterCdBack = await reader.detectColdRestoreState(sessionId)
      expect(afterCdBack.status).toBe('restored')
      if (afterCdBack.status === 'restored') {
        expect(afterCdBack.restoreInfo.cwd).toBe('/alpha')
      }

      // Explicit OSC 7 in the output log still takes precedence over a probed cwd.
      await mgr.appendIncrements(sessionId, 3, [
        { kind: 'output', data: '\x1b]7;file://localhost/alpha/osc7\x07$ ' }
      ])
      const afterOsc7 = await reader.detectColdRestoreState(sessionId)
      expect(afterOsc7.status).toBe('restored')
      if (afterOsc7.status === 'restored') {
        expect(afterOsc7.restoreInfo.cwd).toBe('/alpha/osc7')
      }
    })

    it('preserves endedAt and exitCode when probed cwd updates race closeSession', async () => {
      const sessionId = 'probed-cwd-close-race'
      await mgr.openSession(sessionId, { cwd: '/alpha', cols: 80, rows: 24 })
      const probePromise = mgr.recordProbedCwd(sessionId, '/alpha/sub')
      const closePromise = mgr.closeSession(sessionId, 0)
      await Promise.all([probePromise, closePromise])

      const afterRace = mgr.readMeta(sessionId)
      expect(afterRace?.endedAt).not.toBeNull()
      expect(afterRace?.exitCode).toBe(0)
      expect(afterRace?.lastProbedCwd).toBe('/alpha/sub')

      const sessionDir = join(dir, getHistorySessionDirName(sessionId))
      await updateTerminalHistoryProbedCwd(sessionDir, '/alpha/late')
      const afterLateProbe = mgr.readMeta(sessionId)
      expect(afterLateProbe?.endedAt).not.toBeNull()
      expect(afterLateProbe?.exitCode).toBe(0)
      expect(afterLateProbe?.lastProbedCwd).toBe('/alpha/sub')
    })
  })
})
