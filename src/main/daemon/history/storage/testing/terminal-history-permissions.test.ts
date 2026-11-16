import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import type * as NodeFs from 'node:fs'
import { HistoryManager } from '../history-manager'
import { getHistorySessionDirName } from '../history-paths'
import { flushPendingSessionTreeRemovals } from '../terminal-history-session-tombstone'
import { repairTerminalHistoryPermissions } from '../terminal-history-permission-repair'
import { tightenTerminalHistorySessionDirMode } from '../terminal-history-session-files'
import type { TerminalModes } from '../../../protocol/terminal-modes'
import type { TerminalSnapshot } from '../../../protocol/terminal-snapshot'

const onPosix = it.skipIf(process.platform === 'win32')

const defaultModes: TerminalModes = {
  bracketedPaste: false,
  mouseTracking: false,
  applicationCursor: false,
  alternateScreen: false
}

function makeSnapshot(overrides: Partial<TerminalSnapshot> = {}): TerminalSnapshot {
  return {
    snapshotAnsi: 'secret scrollback\r\n',
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

function modeOf(path: string): number {
  return statSync(path).mode & 0o777
}

function sessionPath(baseDir: string, sessionId: string, file: string): string {
  return join(baseDir, getHistorySessionDirName(sessionId), file)
}

describe('terminal history file permissions', () => {
  const createdDirs: string[] = []

  /** Avoid racing HistoryManager’s deferred startup repair. */
  function isolatedDir(): string {
    const created = mkdtempSync(join(tmpdir(), 'history-perms-test-'))
    createdDirs.push(created)
    return created
  }

  afterEach(async () => {
    await flushPendingSessionTreeRemovals()
    for (const created of createdDirs.splice(0)) {
      rmSync(created, { recursive: true, force: true })
    }
  })

  describe('newly written history', () => {
    let dir: string
    let mgr: HistoryManager

    beforeEach(() => {
      dir = isolatedDir()
      mgr = new HistoryManager(dir)
    })

    afterEach(async () => {
      await mgr.dispose()
    })

    onPosix('pins 0o700 on the session directory and 0o600 on meta.json', async () => {
      await mgr.openSession('sess-1', { cwd: '/home/user', cols: 80, rows: 24 })

      expect(modeOf(join(dir, getHistorySessionDirName('sess-1')))).toBe(0o700)
      expect(modeOf(sessionPath(dir, 'sess-1', 'meta.json'))).toBe(0o600)
    })

    onPosix('pins 0o600 on checkpoint.json, which holds verbatim scrollback', async () => {
      await mgr.openSession('sess-1', { cwd: '/tmp', cols: 80, rows: 24 })
      await mgr.checkpoint('sess-1', makeSnapshot())

      const checkpointPath = sessionPath(dir, 'sess-1', 'checkpoint.json')
      expect(readFileSync(checkpointPath, 'utf-8')).toContain('secret scrollback')
      expect(modeOf(checkpointPath)).toBe(0o600)
    })

    onPosix('pins 0o600 on output.log', async () => {
      await mgr.openSession('sess-1', { cwd: '/tmp', cols: 80, rows: 24 })
      await mgr.appendIncrements('sess-1', 1, [{ kind: 'output', data: 'secret increment' }])

      expect(modeOf(sessionPath(dir, 'sess-1', 'output.log'))).toBe(0o600)
    })

    onPosix(
      'tightens a checkpoint tmp left behind by an older daemon before renaming it',
      async () => {
        await mgr.openSession('sess-1', { cwd: '/tmp', cols: 80, rows: 24 })
        const tmpPath = `${sessionPath(dir, 'sess-1', 'checkpoint.json')}.tmp`
        writeFileSync(tmpPath, 'stale', { mode: 0o644 })

        await mgr.checkpoint('sess-1', makeSnapshot())

        expect(modeOf(sessionPath(dir, 'sess-1', 'checkpoint.json'))).toBe(0o600)
      }
    )
  })

  describe('repairing history written before modes were pinned', () => {
    function seedLegacyTree(): { base: string; sessionDir: string; checkpointPath: string } {
      const base = isolatedDir()
      const sessionDir = join(base, getHistorySessionDirName('legacy'))
      mkdirSync(sessionDir, { recursive: true })
      chmodSync(base, 0o755)
      chmodSync(sessionDir, 0o755)
      const checkpointPath = join(sessionDir, 'checkpoint.json')
      writeFileSync(checkpointPath, '{"scrollbackAnsi":"secret"}')
      chmodSync(checkpointPath, 0o644)
      return { base, sessionDir, checkpointPath }
    }

    onPosix('tightens a pre-existing 0o644 session tree when its writer attaches', () => {
      const { sessionDir, checkpointPath } = seedLegacyTree()

      tightenTerminalHistorySessionDirMode(sessionDir)

      expect(modeOf(sessionDir)).toBe(0o700)
      expect(modeOf(checkpointPath)).toBe(0o600)
    })

    onPosix('sweeps the whole base dir once and then short-circuits', async () => {
      const { base, sessionDir, checkpointPath } = seedLegacyTree()

      await expect(repairTerminalHistoryPermissions(base)).resolves.toBe(true)
      expect(modeOf(base)).toBe(0o700)
      expect(modeOf(sessionDir)).toBe(0o700)
      expect(modeOf(checkpointPath)).toBe(0o600)

      chmodSync(checkpointPath, 0o644)
      await expect(repairTerminalHistoryPermissions(base)).resolves.toBe(false)
      expect(modeOf(checkpointPath)).toBe(0o644)
    })

    onPosix('leaves a session under an open recovery freeze alone', async () => {
      const { base, sessionDir: legacyDir, checkpointPath } = seedLegacyTree()
      const writeErrors: Error[] = []
      const mgr = new HistoryManager(base, {
        onWriteError: (_sessionId, error) => writeErrors.push(error)
      })
      try {
        await mgr.openSession('frozen', { cwd: '/tmp', cols: 80, rows: 24 })
        await mgr.checkpoint('frozen', makeSnapshot())

        // Match production order: fingerprint, sweep, then register the writer.
        const freeze = await mgr.freezeForRecovery('frozen')
        await expect(repairTerminalHistoryPermissions(base)).resolves.toBe(true)
        mgr.registerWriter('frozen', freeze)

        expect(writeErrors.map((error) => error.message)).toEqual([])
        expect(mgr.isSessionDisabled('frozen')).toBe(false)
        await mgr.checkpoint('frozen', makeSnapshot({ snapshotAnsi: 'after the sweep\r\n' }))
        expect(readFileSync(sessionPath(base, 'frozen', 'checkpoint.json'), 'utf-8')).toContain(
          'after the sweep'
        )
      } finally {
        await mgr.dispose()
      }

      expect(modeOf(legacyDir)).toBe(0o700)
      expect(modeOf(checkpointPath)).toBe(0o600)
    })
  })

  describe('hosts where POSIX modes do not apply', () => {
    onPosix('still writes history when chmod itself throws', async () => {
      const base = isolatedDir()
      vi.resetModules()
      vi.doMock('node:fs', async () => {
        const actual = await vi.importActual<typeof NodeFs>('node:fs')
        const chmodSyncThrows = (): never => {
          throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
        }
        return { ...actual, default: actual, chmodSync: chmodSyncThrows }
      })
      try {
        const { HistoryManager: PatchedHistoryManager } = await import('../history-manager')
        const mgr = new PatchedHistoryManager(base)
        await mgr.openSession('chmodless', { cwd: '/tmp', cols: 80, rows: 24 })
        await mgr.checkpoint('chmodless', makeSnapshot())
        await mgr.dispose()
      } finally {
        vi.doUnmock('node:fs')
        vi.resetModules()
      }

      expect(readFileSync(sessionPath(base, 'chmodless', 'checkpoint.json'), 'utf-8')).toContain(
        'secret scrollback'
      )
    })
  })
})
