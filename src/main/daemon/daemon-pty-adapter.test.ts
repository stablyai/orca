/* oxlint-disable max-lines */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonServer } from './daemon-server'
import { getHistorySessionDirName } from './history-paths'
import type { SubprocessHandle } from './session'

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), 'daemon-adapter-test-'))
}

function createMockSubprocess(): SubprocessHandle & {
  _simulateData: (data: string) => void
  _simulateExit: (code: number) => void
} {
  let onDataCb: ((data: string) => void) | null = null
  let onExitCb: ((code: number) => void) | null = null
  return {
    pid: 66666,
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
    dispose: vi.fn(),
    _simulateData(data: string) {
      onDataCb?.(data)
    },
    _simulateExit(code: number) {
      onExitCb?.(code)
    }
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out')
    }
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('DaemonPtyAdapter (IPtyProvider)', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let server: DaemonServer
  let adapter: DaemonPtyAdapter
  let lastSubprocess: ReturnType<typeof createMockSubprocess>
  let lastSpawnOpts: {
    sessionId: string
    cols: number
    rows: number
    cwd?: string
    env?: Record<string, string>
    command?: string
  } | null

  beforeEach(async () => {
    dir = createTestDir()
    socketPath = join(dir, 'test.sock')
    tokenPath = join(dir, 'test.token')

    server = new DaemonServer({
      socketPath,
      tokenPath,
      spawnSubprocess: (opts) => {
        lastSpawnOpts = opts
        lastSubprocess = createMockSubprocess()
        return lastSubprocess
      }
    })
    await server.start()

    adapter = new DaemonPtyAdapter({ socketPath, tokenPath })
    lastSpawnOpts = null
  })

  afterEach(async () => {
    adapter?.dispose()
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('spawn', () => {
    it('returns a result with an id', async () => {
      const result = await adapter.spawn({ cols: 80, rows: 24 })
      expect(result.id).toBeDefined()
      expect(typeof result.id).toBe('string')
    })

    it('uses worktreeId as session prefix when provided', async () => {
      const result = await adapter.spawn({ cols: 80, rows: 24, worktreeId: 'wt-1' })
      expect(result.id).toContain('wt-1')
    })
  })

  describe('write', () => {
    it('sends data to the daemon session', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      adapter.write(id, 'ls\n')

      await new Promise((r) => setTimeout(r, 50))
      expect(lastSubprocess.write).toHaveBeenCalledWith('ls\n')
    })
  })

  describe('resize', () => {
    it('resizes the daemon session', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      adapter.resize(id, 120, 40)

      await new Promise((r) => setTimeout(r, 50))
      expect(lastSubprocess.resize).toHaveBeenCalledWith(120, 40)
    })
  })

  describe('shutdown', () => {
    it('kills the session', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      await adapter.shutdown(id, { immediate: false })
      expect(lastSubprocess.kill).toHaveBeenCalled()
    })
  })

  describe('sendSignal', () => {
    it('sends signal to the session', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      await adapter.sendSignal(id, 'SIGINT')

      expect(lastSubprocess.signal).toHaveBeenCalledWith('SIGINT')
    })
  })

  describe('getCwd', () => {
    it('returns empty string when no CWD tracked', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      const cwd = await adapter.getCwd(id)
      expect(cwd).toBe('')
    })
  })

  describe('getInitialCwd', () => {
    it('returns the cwd passed at spawn time', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24, cwd: '/home/user' })
      const cwd = await adapter.getInitialCwd(id)
      expect(cwd).toBe('/home/user')
    })

    it('returns empty string when no cwd provided', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      const cwd = await adapter.getInitialCwd(id)
      expect(cwd).toBe('')
    })
  })

  describe('clearBuffer', () => {
    it('does not throw', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      await expect(adapter.clearBuffer(id)).resolves.toBeUndefined()
    })
  })

  describe('onData', () => {
    it('routes data events from daemon', async () => {
      const dataPayloads: { id: string; data: string }[] = []
      adapter.onData((payload) => dataPayloads.push(payload))

      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      lastSubprocess._simulateData('hello')

      await waitFor(() => dataPayloads.length > 0)
      expect(dataPayloads[0]).toEqual({ id, data: 'hello' })
    })

    it('coalesces burst data events before serializing daemon stream output', async () => {
      const dataPayloads: { id: string; data: string }[] = []
      adapter.onData((payload) => dataPayloads.push(payload))

      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      lastSubprocess._simulateData('a')
      lastSubprocess._simulateData('b')
      lastSubprocess._simulateData('c')

      await waitFor(() => dataPayloads.length > 0)
      expect(dataPayloads).toEqual([{ id, data: 'abc' }])
    })
  })

  describe('onExit', () => {
    it('routes exit events from daemon', async () => {
      const exits: { id: string; code: number }[] = []
      adapter.onExit((payload) => exits.push(payload))

      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      lastSubprocess._simulateExit(42)

      await waitFor(() => exits.length > 0)
      expect(exits[0]).toEqual({ id, code: 42 })
    })
  })

  describe('spawn with sessionId (reattach)', () => {
    it('returns full snapshot and isReattach when reattaching', async () => {
      const sessionId = 'reattach-test-session'
      const first = await adapter.spawn({ cols: 80, rows: 24, sessionId })
      expect(first.id).toBe(sessionId)
      expect(first.isReattach).toBeUndefined()

      // Write data so the headless emulator captures it
      lastSubprocess._simulateData('hello from shell\r\n')
      await new Promise((r) => setTimeout(r, 50))

      // Spawn again with the same sessionId — should reattach
      const second = await adapter.spawn({ cols: 80, rows: 24, sessionId })
      expect(second.id).toBe(sessionId)
      expect(second.isReattach).toBe(true)
      expect(second.snapshot).toBeDefined()
      expect(second.snapshot).toContain('hello from shell')
    })

    it('includes rehydrateSequences in snapshot when terminal modes are active', async () => {
      const sessionId = 'rehydrate-test'
      await adapter.spawn({ cols: 80, rows: 24, sessionId })

      // Enable bracketed paste mode, then write visible output
      lastSubprocess._simulateData('\x1b[?2004h')
      lastSubprocess._simulateData('prompt$ ')
      await new Promise((r) => setTimeout(r, 50))

      const result = await adapter.spawn({ cols: 80, rows: 24, sessionId })
      expect(result.isReattach).toBe(true)
      expect(result.snapshot).toContain('\x1b[?2004h')
      expect(result.snapshot).toContain('prompt$')
    })

    it('returns plain result for new sessionId', async () => {
      const result = await adapter.spawn({ cols: 80, rows: 24, sessionId: 'brand-new' })
      expect(result.id).toBe('brand-new')
      expect(result.isReattach).toBeUndefined()
      expect(result.snapshot).toBeUndefined()
    })
  })

  describe('attach', () => {
    it('reattaches to existing session and receives events', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })

      // Create a second adapter simulating app restart
      const adapter2 = new DaemonPtyAdapter({ socketPath, tokenPath })
      const dataPayloads: { id: string; data: string }[] = []
      adapter2.onData((payload) => dataPayloads.push(payload))

      await adapter2.attach(id)

      lastSubprocess._simulateData('after-reattach')
      await waitFor(() => dataPayloads.length > 0)
      expect(dataPayloads[0]).toEqual({ id, data: 'after-reattach' })

      adapter2.dispose()
    })
  })

  describe('listProcesses', () => {
    it('returns active sessions', async () => {
      await adapter.spawn({ cols: 80, rows: 24 })
      await adapter.spawn({ cols: 80, rows: 24 })

      const procs = await adapter.listProcesses()
      expect(procs).toHaveLength(2)
      expect(procs[0]).toHaveProperty('id')
      expect(procs[0]).toHaveProperty('cwd')
      expect(procs[0]).toHaveProperty('title')
    })
  })

  describe('hasChildProcesses / getForegroundProcess', () => {
    it('returns false for hasChildProcesses (stub)', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      expect(await adapter.hasChildProcesses(id)).toBe(false)
    })

    it('returns null for getForegroundProcess (stub)', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      expect(await adapter.getForegroundProcess(id)).toBeNull()
    })
  })

  describe('serialize / revive', () => {
    it('serialize returns JSON', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      const state = await adapter.serialize([id])
      expect(() => JSON.parse(state)).not.toThrow()
    })

    it('revive does not throw', async () => {
      await expect(adapter.revive('{}')).resolves.toBeUndefined()
    })
  })

  describe('getDefaultShell / getProfiles', () => {
    it('returns a shell path', async () => {
      const shell = await adapter.getDefaultShell()
      expect(shell.length).toBeGreaterThan(0)
    })

    it('returns profiles', async () => {
      const profiles = await adapter.getProfiles()
      expect(Array.isArray(profiles)).toBe(true)
    })
  })

  describe('killed-session tombstones', () => {
    it('prevents spawn after shutdown for same sessionId', async () => {
      const sessionId = 'tombstone-test'
      await adapter.spawn({ cols: 80, rows: 24, sessionId })
      await adapter.shutdown(sessionId, { immediate: true })

      await expect(adapter.spawn({ cols: 80, rows: 24, sessionId })).rejects.toThrow(
        'was explicitly killed'
      )
    })

    it('allows spawn for different sessionId after shutdown', async () => {
      await adapter.spawn({ cols: 80, rows: 24, sessionId: 'kill-me' })
      await adapter.shutdown('kill-me', { immediate: true })

      const result = await adapter.spawn({ cols: 80, rows: 24, sessionId: 'fresh-one' })
      expect(result.id).toBe('fresh-one')
    })

    it('clearTombstone allows re-spawn', async () => {
      const sessionId = 'cleared-tombstone'
      await adapter.spawn({ cols: 80, rows: 24, sessionId })
      await adapter.shutdown(sessionId, { immediate: true })

      adapter.clearTombstone(sessionId)

      const result = await adapter.spawn({ cols: 80, rows: 24, sessionId })
      expect(result.id).toBe(sessionId)
    })

    it('evicts oldest tombstone when exceeding limit', async () => {
      // Why: MAX_TOMBSTONES is 1000, but spawning that many real sessions is
      // slow. Instead verify the eviction logic by spawning a small batch and
      // checking the oldest tombstone is gone after crossing the cap. We access
      // the private map size via the public API: the oldest session should
      // become spawnable again once evicted.
      const ids: string[] = []
      for (let i = 0; i < 5; i++) {
        const id = `evict-${i}`
        ids.push(id)
        await adapter.spawn({ cols: 80, rows: 24, sessionId: id })
        await adapter.shutdown(id, { immediate: true })
      }

      // All 5 should be tombstoned
      for (const id of ids) {
        await expect(adapter.spawn({ cols: 80, rows: 24, sessionId: id })).rejects.toThrow(
          'was explicitly killed'
        )
      }

      // clearTombstone the first one, then re-kill it — it should still work
      adapter.clearTombstone(ids[0])
      await adapter.spawn({ cols: 80, rows: 24, sessionId: ids[0] })
      await adapter.shutdown(ids[0], { immediate: true })

      // First tombstone was re-added at the end of the Map, so eviction
      // order is now [evict-1, evict-2, evict-3, evict-4, evict-0]
      await expect(adapter.spawn({ cols: 80, rows: 24, sessionId: ids[0] })).rejects.toThrow(
        'was explicitly killed'
      )
    })
  })

  describe('reconcileOnStartup', () => {
    it('returns alive sessions for valid worktrees', async () => {
      const wt = 'repo-a::/wt/active'
      await adapter.spawn({ cols: 80, rows: 24, worktreeId: wt })

      const { alive, killed } = await adapter.reconcileOnStartup(new Set([wt]))
      expect(alive).toHaveLength(1)
      expect(alive[0]).toContain(wt)
      expect(killed).toHaveLength(0)
    })

    it('kills sessions for removed worktrees', async () => {
      const wt = 'repo-a::/wt/removed'
      await adapter.spawn({ cols: 80, rows: 24, worktreeId: wt })

      const { alive, killed } = await adapter.reconcileOnStartup(new Set(['repo-a::/wt/other']))
      expect(alive).toHaveLength(0)
      expect(killed).toHaveLength(1)
      expect(killed[0]).toContain(wt)
    })

    it('handles mix of valid and orphaned sessions', async () => {
      const keep = 'repo-a::/wt/keep'
      const drop = 'repo-a::/wt/delete'
      await adapter.spawn({ cols: 80, rows: 24, worktreeId: keep })
      await adapter.spawn({ cols: 80, rows: 24, worktreeId: drop })

      const { alive, killed } = await adapter.reconcileOnStartup(new Set([keep]))
      expect(alive).toHaveLength(1)
      expect(killed).toHaveLength(1)
    })

    it('correctly parses hyphenated worktreeIds', async () => {
      const complexId = 'repo-abc::/Users/dev/my-feature-branch'
      await adapter.spawn({ cols: 80, rows: 24, worktreeId: complexId })

      const { alive, killed } = await adapter.reconcileOnStartup(new Set([complexId]))
      expect(alive).toHaveLength(1)
      expect(killed).toHaveLength(0)
    })

    it('kills sessions whose id does not match the minted format, even if id is in valid set', async () => {
      // Why: parsePtySessionId rejects bare UUIDs (no `@@`) and ids without
      // the `::` worktree shape. Such sessions can't be attributed to any
      // current worktree and must be treated as orphans regardless of
      // valid-set membership. Passing the bare-uuid as a member of
      // validWorktreeIds proves the new strict parser short-circuits the
      // membership check — under the old loose parser this session would
      // have been kept.
      const sessionId = 'bare-uuid-no-separators'
      await adapter.spawn({ cols: 80, rows: 24, sessionId })

      const { alive, killed } = await adapter.reconcileOnStartup(new Set([sessionId]))
      expect(alive).toHaveLength(0)
      expect(killed).toHaveLength(1)
    })
  })

  describe('dispose', () => {
    it('disconnects without killing sessions', async () => {
      await adapter.spawn({ cols: 80, rows: 24, worktreeId: 'wt-1' })
      adapter.dispose()

      // Session survives — verify by connecting new adapter
      const adapter2 = new DaemonPtyAdapter({ socketPath, tokenPath })
      const procs = await adapter2.listProcesses()
      expect(procs).toHaveLength(1)
      adapter2.dispose()
    })
  })

  describe('history integration', () => {
    let historyDir: string
    let historyAdapter: DaemonPtyAdapter

    beforeEach(() => {
      historyDir = join(dir, 'history')
    })

    afterEach(async () => {
      historyAdapter?.dispose()
    })

    it('does not write to disk on individual data events (checkpoint-based)', async () => {
      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })

      const { id } = await historyAdapter.spawn({
        cols: 80,
        rows: 24,
        cwd: '/home/user',
        sessionId: 'hist-test'
      })

      lastSubprocess._simulateData('hello from pty\r\n')
      await new Promise((r) => setTimeout(r, 50))

      // Why: checkpoint-based persistence does not write on every data event.
      // No scrollback.bin should exist — checkpoints write checkpoint.json on a timer.
      expect(existsSync(join(historyDir, getHistorySessionDirName(id), 'scrollback.bin'))).toBe(
        false
      )
    })

    it('checkpoints only dirty sessions on the periodic timer', async () => {
      const adapterClass = DaemonPtyAdapter as unknown as { CHECKPOINT_INTERVAL_MS: number }
      const previousInterval = adapterClass.CHECKPOINT_INTERVAL_MS
      adapterClass.CHECKPOINT_INTERVAL_MS = 25

      try {
        historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
        const { id } = await historyAdapter.spawn({
          cols: 80,
          rows: 24,
          cwd: '/home/user',
          sessionId: 'dirty-checkpoint'
        })
        const checkpointSpy = vi.spyOn(historyAdapter.getHistoryManager()!, 'checkpoint')

        await new Promise((r) => setTimeout(r, 80))

        // Why: idle terminals can be numerous. A periodic pass with no data
        // must not serialize every live daemon session just because it exists.
        expect(checkpointSpy).not.toHaveBeenCalled()

        lastSubprocess._simulateData('new output\r\n')
        await waitFor(() => checkpointSpy.mock.calls.length === 1)
        expect(checkpointSpy).toHaveBeenCalledWith(
          id,
          expect.objectContaining({ snapshotAnsi: expect.stringContaining('new output') })
        )

        await new Promise((r) => setTimeout(r, 80))
        expect(checkpointSpy).toHaveBeenCalledTimes(1)
      } finally {
        adapterClass.CHECKPOINT_INTERVAL_MS = previousInterval
      }
    })

    it('writes meta.json with endedAt on exit', async () => {
      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })

      const { id } = await historyAdapter.spawn({
        cols: 80,
        rows: 24,
        sessionId: 'exit-hist'
      })

      lastSubprocess._simulateExit(0)
      await new Promise((r) => setTimeout(r, 50))

      const meta = JSON.parse(
        readFileSync(join(historyDir, getHistorySessionDirName(id), 'meta.json'), 'utf-8')
      )
      expect(meta.endedAt).toBeDefined()
      expect(meta.exitCode).toBe(0)
    })

    it('removes history on explicit shutdown', async () => {
      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })

      const { id } = await historyAdapter.spawn({
        cols: 80,
        rows: 24,
        sessionId: 'shutdown-hist'
      })

      lastSubprocess._simulateData('data')
      await new Promise((r) => setTimeout(r, 50))

      expect(existsSync(join(historyDir, getHistorySessionDirName(id)))).toBe(true)

      await historyAdapter.shutdown(id, { immediate: true })
      await new Promise((r) => setTimeout(r, 50))

      expect(existsSync(join(historyDir, getHistorySessionDirName(id)))).toBe(false)
    })

    it('returns cold restore data when disk history has unclean shutdown', async () => {
      // Simulate a previous daemon crash: write history files without endedAt
      const sessionId = 'cold-restore-test'
      const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(
        join(sessionDir, 'meta.json'),
        JSON.stringify({
          cwd: '/projects/myapp',
          cols: 120,
          rows: 40,
          startedAt: '2026-04-15T10:00:00Z',
          endedAt: null,
          exitCode: null
        })
      )
      writeFileSync(join(sessionDir, 'scrollback.bin'), '$ npm run dev\r\nServer running...\r\n')

      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })

      const result = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })
      expect(result.id).toBe(sessionId)
      expect(result.coldRestore).toBeDefined()
      expect(result.coldRestore!.scrollback).toContain('Server running')
      expect(result.coldRestore!.cwd).toBe('/projects/myapp')
      expect(lastSpawnOpts).toMatchObject({
        sessionId,
        cwd: '/projects/myapp',
        cols: 120,
        rows: 40
      })
    })

    it('returns same cold restore on StrictMode double-mount (sticky cache)', async () => {
      const sessionId = 'sticky-cache-test'
      const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(
        join(sessionDir, 'meta.json'),
        JSON.stringify({
          cwd: '/tmp',
          cols: 80,
          rows: 24,
          startedAt: '2026-04-15T10:00:00Z',
          endedAt: null,
          exitCode: null
        })
      )
      writeFileSync(join(sessionDir, 'scrollback.bin'), 'cached output')

      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })

      const first = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })
      expect(first.coldRestore).toBeDefined()

      // Second call (StrictMode remount) should get cached data
      const second = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })
      expect(second.coldRestore).toBeDefined()
      expect(second.coldRestore!.scrollback).toBe('cached output')

      // After ack, cold restore should not be returned
      historyAdapter.ackColdRestore(sessionId)
      const third = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })
      expect(third.coldRestore).toBeUndefined()
    })

    it('opens session for checkpointing after cold restore', async () => {
      const sessionId = 'post-restore-data'
      const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(
        join(sessionDir, 'meta.json'),
        JSON.stringify({
          cwd: '/tmp',
          cols: 80,
          rows: 24,
          startedAt: '2026-04-15T10:00:00Z',
          endedAt: null,
          exitCode: null
        })
      )
      writeFileSync(join(sessionDir, 'scrollback.bin'), 'old output')

      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })

      const result = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })
      expect(result.coldRestore).toBeDefined()

      await new Promise((r) => setTimeout(r, 50))

      // Why: checkpoint-based persistence opens the session for future
      // checkpointing but does not seed scrollback.bin. New data is persisted
      // via periodic checkpoint timer, not per-chunk appendData.
      const meta = JSON.parse(
        readFileSync(join(historyDir, getHistorySessionDirName(sessionId), 'meta.json'), 'utf-8')
      )
      expect(meta.cwd).toBe('/tmp')
      expect(meta.cols).toBe(80)
      expect(meta.rows).toBe(24)
    })

    it('does not cold-restore for clean shutdown (endedAt set)', async () => {
      const sessionId = 'clean-exit'
      const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(
        join(sessionDir, 'meta.json'),
        JSON.stringify({
          cwd: '/tmp',
          cols: 80,
          rows: 24,
          startedAt: '2026-04-15T10:00:00Z',
          endedAt: '2026-04-15T12:00:00Z',
          exitCode: 0
        })
      )
      writeFileSync(join(sessionDir, 'scrollback.bin'), 'old data')

      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })

      const result = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })
      expect(result.coldRestore).toBeUndefined()
    })

    it('stores history under an encoded directory key for Windows-safe session ids', async () => {
      const sessionId = 'repo1::/path/wt1@@abcd'
      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })

      const { id } = await historyAdapter.spawn({
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        sessionId
      })

      expect(id).toBe(sessionId)
      expect(existsSync(join(historyDir, getHistorySessionDirName(sessionId), 'meta.json'))).toBe(
        true
      )
    })
  })

  describe('respawn on daemon death', () => {
    it('respawns the daemon and retries when the socket disappears', async () => {
      let respawnServer: DaemonServer | undefined
      const respawnFn = vi.fn(async () => {
        respawnServer = new DaemonServer({
          socketPath,
          tokenPath,
          spawnSubprocess: () => createMockSubprocess()
        })
        await respawnServer.start()
      })

      const respawnAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, respawn: respawnFn })

      // First spawn succeeds normally
      const r1 = await respawnAdapter.spawn({ cols: 80, rows: 24 })
      expect(r1.id).toBeDefined()

      // Kill the server to simulate daemon death
      await server.shutdown()

      // Next spawn should detect the dead socket, call respawn, and succeed
      const r2 = await respawnAdapter.spawn({ cols: 80, rows: 24 })
      expect(r2.id).toBeDefined()
      expect(respawnFn).toHaveBeenCalledOnce()

      respawnAdapter.dispose()
      await respawnServer?.shutdown()
    })

    it('propagates the error when no respawn callback is provided', async () => {
      const noRespawnAdapter = new DaemonPtyAdapter({ socketPath, tokenPath })

      // First spawn succeeds
      await noRespawnAdapter.spawn({ cols: 80, rows: 24 })

      // Kill the server
      await server.shutdown()

      // Next spawn should fail with the original socket error
      await expect(noRespawnAdapter.spawn({ cols: 80, rows: 24 })).rejects.toThrow()

      noRespawnAdapter.dispose()
    })

    it('coalesces concurrent respawns so only one daemon is forked', async () => {
      let respawnServer: DaemonServer | undefined
      const respawnFn = vi.fn(async () => {
        respawnServer = new DaemonServer({
          socketPath,
          tokenPath,
          spawnSubprocess: () => createMockSubprocess()
        })
        await respawnServer.start()
      })

      const respawnAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, respawn: respawnFn })

      // First spawn connects
      await respawnAdapter.spawn({ cols: 80, rows: 24 })

      // Kill daemon
      await server.shutdown()

      // Fire two spawns concurrently — both should succeed but only one respawn
      const [r1, r2] = await Promise.all([
        respawnAdapter.spawn({ cols: 80, rows: 24 }),
        respawnAdapter.spawn({ cols: 80, rows: 24 })
      ])
      expect(r1.id).toBeDefined()
      expect(r2.id).toBeDefined()
      expect(respawnFn).toHaveBeenCalledOnce()

      respawnAdapter.dispose()
      await respawnServer?.shutdown()
    })

    it('propagates respawn failure to the caller', async () => {
      const respawnFn = vi.fn(async () => {
        throw new Error('Daemon entry file missing')
      })

      const respawnAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, respawn: respawnFn })
      await respawnAdapter.spawn({ cols: 80, rows: 24 })
      await server.shutdown()

      await expect(respawnAdapter.spawn({ cols: 80, rows: 24 })).rejects.toThrow(
        'Daemon entry file missing'
      )

      respawnAdapter.dispose()
    })
  })

  // Why: the restart flow (docs/daemon-staleness-ux.md §Phase 1 step 1) relies
  // on these two primitives to fan synthetic pty:exit out to every attached
  // session *before* tearing the adapter down. The design doc calls out
  // session.ts:246-252 as the reason — the daemon's kill-all-and-shutdown
  // explicitly does NOT fan exits back through onExit. Without the fanout the
  // renderer would black-hole writes against a disposed adapter.
  describe('fanoutSyntheticExits / getActiveSessionIds (restart primitives)', () => {
    it('reports every live spawn in getActiveSessionIds', async () => {
      const { id: id1 } = await adapter.spawn({ cols: 80, rows: 24 })
      const { id: id2 } = await adapter.spawn({ cols: 80, rows: 24 })
      const active = adapter.getActiveSessionIds()
      expect(active).toContain(id1)
      expect(active).toContain(id2)
      expect(active).toHaveLength(2)
    })

    it('emits a synthetic exit for every active id with the supplied code', () => {
      const exits: { id: string; code: number }[] = []
      adapter.onExit((payload) => exits.push(payload))

      const ids = ['sess-a', 'sess-b', 'sess-c']
      const internals = adapter as unknown as { activeSessionIds: Set<string> }
      for (const id of ids) {
        internals.activeSessionIds.add(id)
      }

      adapter.fanoutSyntheticExits(-1)

      expect(exits).toHaveLength(3)
      expect(exits.map((e) => e.id).sort()).toEqual([...ids].sort())
      for (const { code } of exits) {
        expect(code).toBe(-1)
      }
    })

    it('clears activeSessionIds after fanout so a second call is a no-op', () => {
      const exits: { id: string; code: number }[] = []
      adapter.onExit((payload) => exits.push(payload))

      const internals = adapter as unknown as { activeSessionIds: Set<string> }
      internals.activeSessionIds.add('sess-a')

      adapter.fanoutSyntheticExits(-1)
      expect(exits).toHaveLength(1)
      expect(adapter.getActiveSessionIds()).toEqual([])

      adapter.fanoutSyntheticExits(-1)
      expect(exits).toHaveLength(1)
    })

    it('propagates to every registered exit listener in order', () => {
      const aExits: { id: string; code: number }[] = []
      const bExits: { id: string; code: number }[] = []
      adapter.onExit((payload) => aExits.push(payload))
      adapter.onExit((payload) => bExits.push(payload))

      const internals = adapter as unknown as { activeSessionIds: Set<string> }
      internals.activeSessionIds.add('sess-a')

      adapter.fanoutSyntheticExits(-1)

      expect(aExits).toEqual([{ id: 'sess-a', code: -1 }])
      expect(bExits).toEqual([{ id: 'sess-a', code: -1 }])
    })
  })
})
