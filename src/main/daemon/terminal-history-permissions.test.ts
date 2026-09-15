import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import type * as NodeFs from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { HistoryManager } from './history-manager'
import { HistoryReader } from './history-reader'
import { getHistorySessionDirName } from './history-paths'
import { flushPendingSessionTreeRemovals } from './terminal-history-session-tombstone'
import {
  repairTerminalHistoryPermissions,
  scheduleTerminalHistoryPermissionRepair
} from './terminal-history-permission-repair'
import { tightenTerminalHistorySessionDirMode } from './terminal-history-session-files'
import type { TerminalModes, TerminalSnapshot } from './types'

const onPosix = it.skipIf(process.platform === 'win32')
const REPAIR_MARKER_NAME = '.permissions-repaired-v1'

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

/** `process.platform` is read at call time, so the Windows branch is reachable from a POSIX runner. */
function stubPlatform(platform: NodeJS.Platform): () => void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  return () => {
    if (original) {
      Object.defineProperty(process, 'platform', original)
    }
  }
}

describe('terminal history file permissions', () => {
  const createdDirs: string[] = []

  /** Repair tests need a base dir with no HistoryManager racing its own startup sweep against them. */
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

    onPosix('keeps the sweep marker out of the restorable-session listing', async () => {
      await mgr.openSession('sess-1', { cwd: '/tmp', cols: 80, rows: 24 })
      await repairTerminalHistoryPermissions(dir)

      expect(existsSync(join(dir, REPAIR_MARKER_NAME))).toBe(true)
      expect(new HistoryReader(dir).listRestorable()).toEqual(['sess-1'])
    })
  })

  describe('repairing history written before modes were pinned', () => {
    /** A base dir shaped like one written under a default umask: world-readable throughout. */
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

      // Marker-guarded: a later launch must not re-walk 10k session trees.
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

        // The production ordering: freeze fingerprints, the sweep runs, then the writer re-registers.
        const freeze = await mgr.freezeForRecovery('frozen')
        await expect(repairTerminalHistoryPermissions(base)).resolves.toBe(true)
        mgr.registerWriter('frozen', freeze)

        expect(writeErrors.map((error) => error.message)).toEqual([])
        expect(mgr.isSessionDisabled('frozen')).toBe(false)
        // Persistence, not just the absence of an error: the pane must still reach disk.
        await mgr.checkpoint('frozen', makeSnapshot({ snapshotAnsi: 'after the sweep\r\n' }))
        expect(readFileSync(sessionPath(base, 'frozen', 'checkpoint.json'), 'utf-8')).toContain(
          'after the sweep'
        )
      } finally {
        await mgr.dispose()
      }

      // Narrow skip: every session that is not frozen is still tightened by the same sweep.
      expect(modeOf(legacyDir)).toBe(0o700)
      expect(modeOf(checkpointPath)).toBe(0o600)
    })

    onPosix('sweeps a session tree once its recovery freeze is released', async () => {
      const base = isolatedDir()
      const mgr = new HistoryManager(base)
      try {
        await mgr.openSession('thawed', { cwd: '/tmp', cols: 80, rows: 24 })
        const freeze = await mgr.freezeForRecovery('thawed')
        mgr.abandonRecoveryFreeze(freeze)
      } finally {
        await mgr.dispose()
      }
      const sessionDir = join(base, getHistorySessionDirName('thawed'))
      chmodSync(sessionDir, 0o755)

      await expect(repairTerminalHistoryPermissions(base)).resolves.toBe(true)

      expect(modeOf(sessionDir)).toBe(0o700)
    })

    onPosix('defers the sweep off the daemon-init critical path and runs it once', async () => {
      const { base, checkpointPath } = seedLegacyTree()
      vi.useFakeTimers()
      try {
        const first = scheduleTerminalHistoryPermissionRepair(base)
        // Both startup accessors ask for the same tree; only the first arms a sweep.
        expect(scheduleTerminalHistoryPermissionRepair(base)).toBeNull()
        expect(vi.getTimerCount()).toBe(1)

        // Still armed, and the tree still untouched, well past daemon init — the sibling
        // history GC waits the same 10s over this directory for the same reason.
        await vi.advanceTimersByTimeAsync(9_999)
        expect(vi.getTimerCount()).toBe(1)
        expect(existsSync(join(base, REPAIR_MARKER_NAME))).toBe(false)
        expect(modeOf(checkpointPath)).toBe(0o644)

        await vi.advanceTimersByTimeAsync(1)
        await expect(first).resolves.toBe(true)
      } finally {
        vi.useRealTimers()
      }
      expect(modeOf(checkpointPath)).toBe(0o600)
    })

    onPosix('finishes and marks the sweep done even when every chmod is rejected', async () => {
      const { base } = seedLegacyTree()
      vi.resetModules()
      vi.doMock('node:fs/promises', async () => {
        const actual = await vi.importActual<typeof NodeFsPromises>('node:fs/promises')
        return {
          ...actual,
          default: actual,
          chmod: () => Promise.reject(Object.assign(new Error('EPERM'), { code: 'EPERM' }))
        }
      })
      try {
        const { repairTerminalHistoryPermissions: patchedRepair } =
          await import('./terminal-history-permission-repair')
        await expect(patchedRepair(base)).resolves.toBe(true)
      } finally {
        vi.doUnmock('node:fs/promises')
        vi.resetModules()
      }

      expect(existsSync(join(base, REPAIR_MARKER_NAME))).toBe(true)
    })
  })

  describe('hosts where POSIX modes do not apply', () => {
    it('skips the repair sweep on win32 rather than touching the tree', async () => {
      const base = isolatedDir()
      const restore = stubPlatform('win32')
      try {
        await expect(repairTerminalHistoryPermissions(base)).resolves.toBe(false)
      } finally {
        restore()
      }
      expect(existsSync(join(base, REPAIR_MARKER_NAME))).toBe(false)
    })

    it('still writes history when the platform reports win32', async () => {
      const base = isolatedDir()
      const restore = stubPlatform('win32')
      const mgr = new HistoryManager(base)
      try {
        await mgr.openSession('win-sess', { cwd: 'C:\\tmp', cols: 80, rows: 24 })
        await mgr.checkpoint('win-sess', makeSnapshot())
      } finally {
        await mgr.dispose()
        restore()
      }

      expect(readFileSync(sessionPath(base, 'win-sess', 'checkpoint.json'), 'utf-8')).toContain(
        'secret scrollback'
      )
    })

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
        const { HistoryManager: PatchedHistoryManager } = await import('./history-manager')
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
