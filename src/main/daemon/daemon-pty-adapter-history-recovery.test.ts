/* History recovery / quarantine / reconcile regressions for DaemonPtyAdapter. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  chmodSync,
  closeSync,
  existsSync,
  ftruncateSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonServer } from './daemon-server'
import { HistoryManager } from './history-manager'
import { getHistorySessionDirName } from './history-paths'
import {
  TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES,
  TERMINAL_HISTORY_LEGACY_SCROLLBACK_MAX_BYTES
} from './terminal-history-file-limits'
import {
  getTerminalHistoryQuarantineOwnerDir,
  hasTerminalHistoryRecoveryProtection
} from './terminal-history-recovery-quarantine'
import { encodeLogBatch, encodeLogHeader } from './terminal-history-log'
import type { HistoryReader } from './history-reader'
import type { SubprocessHandle } from './session'
import type { DaemonFileLog } from './daemon-file-log'
import type * as DaemonHealthModule from './daemon-health'
import { getDaemonSocketPath } from './daemon-spawner'

const { getMacDaemonSystemResolverHealthMock } = vi.hoisted(() => ({
  getMacDaemonSystemResolverHealthMock: vi.fn(async () => 'unknown')
}))

// Why not just posix: mode 0o500 does not block writes for uid 0, so root CI containers would never hit the failure.
const itOnUnprivilegedPosix = it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)

vi.mock('./daemon-health', async (importOriginal) => {
  const actual = await importOriginal<typeof DaemonHealthModule>()
  return {
    ...actual,
    getMacDaemonSystemResolverHealth: getMacDaemonSystemResolverHealthMock
  }
})

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), 'daemon-adapter-history-recovery-'))
}

function createSparseFile(path: string, bytes: number): void {
  const descriptor = openSync(path, 'w')
  ftruncateSync(descriptor, bytes)
  closeSync(descriptor)
}

async function leaveFailedQuarantineProtection(
  historyPath: string,
  sessionId: string
): Promise<void> {
  const manager = new HistoryManager(historyPath)
  const recoveryFreeze = await manager.freezeForRecovery(sessionId)
  // Occupy the quarantine root with a file so the owner-directory mkdir fails.
  writeFileSync(
    dirname(getTerminalHistoryQuarantineOwnerDir(historyPath, sessionId)),
    'block quarantine'
  )
  await manager.openSession(sessionId, {
    cwd: '/replacement',
    cols: 80,
    rows: 24,
    recoveryFreeze,
    quarantineUnreadableRecovery: true
  })
  expect(manager.isSessionDisabled(sessionId)).toBe(true)
}

function createMockSubprocess(dataOnSubscribe?: string): SubprocessHandle & {
  pause: ReturnType<typeof vi.fn<() => void>>
  resume: ReturnType<typeof vi.fn<() => void>>
  _simulateData: (data: string) => void
  _simulateExit: (code: number) => void
} {
  let onDataCb: ((data: string) => void) | null = null
  let onExitCb: ((code: number) => void) | null = null
  return {
    // Why: getCwd falls back to OS pid lookup; an implausibly-high fake pid can't collide with a real process' cwd.
    pid: 999_999_999,
    getForegroundProcess: vi.fn(() => null),
    write: vi.fn(),
    resize: vi.fn(),
    pause: vi.fn<() => void>(),
    resume: vi.fn<() => void>(),
    kill: vi.fn(() => setTimeout(() => onExitCb?.(0), 5)),
    forceKill: vi.fn(() => setTimeout(() => onExitCb?.(137), 5)),
    signal: vi.fn(),
    onData(cb) {
      onDataCb = cb
      if (dataOnSubscribe) {
        cb(dataOnSubscribe)
      }
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

describe('DaemonPtyAdapter history recovery', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let server: DaemonServer
  let adapter: DaemonPtyAdapter
  let lastSubprocess: ReturnType<typeof createMockSubprocess>
  let historyDir: string
  let historyAdapter: DaemonPtyAdapter

  beforeEach(async () => {
    dir = createTestDir()
    historyDir = join(dir, 'history')
    socketPath = getDaemonSocketPath(dir)
    tokenPath = join(dir, 'test.token')

    const daemonLog: DaemonFileLog = {
      log: () => {},
      close() {}
    }
    server = new DaemonServer({
      socketPath,
      tokenPath,
      log: daemonLog,
      spawnSubprocess: () => {
        lastSubprocess = createMockSubprocess()
        return lastSubprocess
      }
    })
    await server.start()

    adapter = new DaemonPtyAdapter({ socketPath, tokenPath })
    getMacDaemonSystemResolverHealthMock.mockReset()
    getMacDaemonSystemResolverHealthMock.mockResolvedValue('unknown')
  })

  afterEach(async () => {
    historyAdapter?.dispose()
    adapter?.dispose()
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  it('suspends history when keepHistory cannot read its final checkpoint', async () => {
    historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
    const { id } = await historyAdapter.spawn({
      cols: 80,
      rows: 24,
      sessionId: 'sleep-unreadable'
    })
    const manager = historyAdapter.getHistoryManager()!
    const suspend = vi.spyOn(manager, 'suspendSession')
    const reader = (historyAdapter as unknown as { historyReader: HistoryReader }).historyReader
    vi.spyOn(reader, 'detectColdRestoreState').mockResolvedValue({
      status: 'unreadable',
      sessionId: id
    })

    await historyAdapter.shutdown(id, { immediate: true, keepHistory: true })

    expect(suspend).toHaveBeenCalledWith(id)
    const metaPath = join(historyDir, getHistorySessionDirName(id), 'meta.json')
    expect(JSON.parse(readFileSync(metaPath, 'utf-8')).endedAt).toBeNull()
  })

  it('suspends an empty final checkpoint with unreadable post-checkpoint recovery', async () => {
    historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
    const { id } = await historyAdapter.spawn({
      cols: 80,
      rows: 24,
      sessionId: 'sleep-empty-mixed-recovery'
    })
    const manager = historyAdapter.getHistoryManager()!
    const suspend = vi.spyOn(manager, 'suspendSession')
    const originalCheckpoint = manager.checkpoint.bind(manager)
    let malformedLog!: Buffer
    vi.spyOn(manager, 'checkpoint').mockImplementation(async (...args) => {
      const result = await originalCheckpoint(...args)
      const sessionDir = join(historyDir, getHistorySessionDirName(id))
      const checkpoint = JSON.parse(readFileSync(join(sessionDir, 'checkpoint.json'), 'utf-8'))
      malformedLog = Buffer.concat([
        encodeLogHeader(checkpoint.generation),
        encodeLogBatch(1, [
          { kind: 'output', data: 'only post-checkpoint copy\r\n' },
          { kind: 'resize', cols: 1_001, rows: 24 }
        ])
      ])
      writeFileSync(join(sessionDir, 'output.log'), malformedLog)
      return result
    })

    await historyAdapter.shutdown(id, { immediate: true, keepHistory: true })

    expect(suspend).toHaveBeenCalledWith(id)
    const sessionDir = join(historyDir, getHistorySessionDirName(id))
    expect(readFileSync(join(sessionDir, 'output.log'))).toEqual(malformedLog)
    expect(JSON.parse(readFileSync(join(sessionDir, 'meta.json'), 'utf-8')).endedAt).toBeNull()
  })

  it('keeps the checkpoint timer out of a final keepHistory checkpoint', async () => {
    const adapterClass = DaemonPtyAdapter as unknown as { CHECKPOINT_INTERVAL_MS: number }
    const previousInterval = adapterClass.CHECKPOINT_INTERVAL_MS
    adapterClass.CHECKPOINT_INTERVAL_MS = 5
    try {
      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
      const { id } = await historyAdapter.spawn({
        cols: 80,
        rows: 24,
        sessionId: 'sleep-checkpoint-exclusive'
      })
      const manager = historyAdapter.getHistoryManager()!
      const originalCheckpoint = manager.checkpoint.bind(manager)
      let releaseCheckpoint!: () => void
      let checkpointCalls = 0
      vi.spyOn(manager, 'checkpoint').mockImplementation(async (...args) => {
        if (++checkpointCalls === 1) {
          await new Promise<void>((resolve) => {
            releaseCheckpoint = resolve
          })
        }
        return originalCheckpoint(...args)
      })

      const shuttingDown = historyAdapter.shutdown(id, {
        immediate: true,
        keepHistory: true
      })
      await waitFor(() => releaseCheckpoint !== undefined)
      lastSubprocess._simulateData('arrived during final checkpoint')
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(checkpointCalls).toBe(1)

      releaseCheckpoint()
      await shuttingDown
      expect(checkpointCalls).toBe(1)
    } finally {
      adapterClass.CHECKPOINT_INTERVAL_MS = previousInterval
    }
  })

  it('serializes concurrent keepHistory and disconnectOnly checkpoints', async () => {
    historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
    const sessionIds = await Promise.all(
      ['queued-checkpoint-a', 'queued-checkpoint-b', 'queued-checkpoint-c'].map(
        async (sessionId) =>
          (
            await historyAdapter.spawn({
              cols: 80,
              rows: 24,
              sessionId
            })
          ).id
      )
    )
    const internals = historyAdapter as unknown as {
      checkpointSessions(
        sessionIds: Iterable<string>,
        opts?: { final?: boolean; teardown?: boolean }
      ): Promise<Set<string>>
      runExclusiveCheckpoint(operation: () => Promise<void>, options?: object): Promise<void>
    }
    const originalCheckpointSessions = internals.checkpointSessions.bind(historyAdapter)
    // Call-through spy: entering the exclusive gate is the observable "queued behind the in-flight checkpoint" moment.
    const exclusiveEntries = vi.spyOn(internals, 'runExclusiveCheckpoint')
    let activeCheckpoints = 0
    let maxActiveCheckpoints = 0
    let checkpointCalls = 0
    let releaseFirstCheckpoint!: () => void
    let firstCheckpointStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      firstCheckpointStarted = resolve
    })
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirstCheckpoint = resolve
    })
    vi.spyOn(internals, 'checkpointSessions').mockImplementation(async (...args) => {
      checkpointCalls++
      activeCheckpoints++
      maxActiveCheckpoints = Math.max(maxActiveCheckpoints, activeCheckpoints)
      try {
        if (checkpointCalls === 1) {
          firstCheckpointStarted()
          await firstRelease
        }
        return await originalCheckpointSessions(...args)
      } finally {
        activeCheckpoints--
      }
    })

    const firstShutdown = historyAdapter.shutdown(sessionIds[0], {
      immediate: true,
      keepHistory: true
    })
    await firstStarted
    const queuedOperations = [
      historyAdapter.shutdown(sessionIds[1], { immediate: true, keepHistory: true }),
      historyAdapter.shutdown(sessionIds[2], { immediate: true, keepHistory: true }),
      historyAdapter.disconnectOnly()
    ]
    // Why not a fixed sleep: releasing before both queued shutdowns enter the gate makes maxActiveCheckpoints===1 vacuous.
    // (disconnectOnly's own entry lands after it drains the keepHistory shutdowns, so it can't be waited on here.)
    await waitFor(() => exclusiveEntries.mock.calls.length >= 3)
    releaseFirstCheckpoint()
    await Promise.all([firstShutdown, ...queuedOperations])

    expect(checkpointCalls).toBe(4)
    expect(maxActiveCheckpoints).toBe(1)
  })

  it('reschedules another dirty session after a keepHistory checkpoint', async () => {
    const adapterClass = DaemonPtyAdapter as unknown as { CHECKPOINT_INTERVAL_MS: number }
    const previousInterval = adapterClass.CHECKPOINT_INTERVAL_MS
    adapterClass.CHECKPOINT_INTERVAL_MS = 25
    try {
      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
      const sleeping = await historyAdapter.spawn({
        cols: 80,
        rows: 24,
        sessionId: 'sleep-with-dirty-peer'
      })
      const peer = await historyAdapter.spawn({
        cols: 80,
        rows: 24,
        sessionId: 'dirty-peer'
      })
      const appendSpy = vi.spyOn(historyAdapter.getHistoryManager()!, 'appendIncrements')
      lastSubprocess._simulateData('peer output before sleep\r\n')

      await historyAdapter.shutdown(sleeping.id, { immediate: true, keepHistory: true })
      await waitFor(() => appendSpy.mock.calls.some(([sessionId]) => sessionId === peer.id))

      expect(appendSpy).toHaveBeenCalledWith(
        peer.id,
        expect.any(Number),
        expect.arrayContaining([
          expect.objectContaining({ kind: 'output', data: 'peer output before sleep\r\n' })
        ])
      )
    } finally {
      adapterClass.CHECKPOINT_INTERVAL_MS = previousInterval
    }
  })

  it.each([
    ['checkpoint.json', TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES + 1],
    ['scrollback.bin', TERMINAL_HISTORY_LEGACY_SCROLLBACK_MAX_BYTES + 1]
  ])('quarantines an unreadable oversized %s instead of deleting it', async (file, bytes) => {
    const sessionId = `oversized-${file}`
    const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(
      join(sessionDir, 'meta.json'),
      JSON.stringify({
        cwd: '/projects/oversized',
        cols: 80,
        rows: 24,
        startedAt: '2026-07-25T10:00:00Z',
        endedAt: null,
        exitCode: null
      })
    )
    createSparseFile(join(sessionDir, file), bytes)
    historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })

    const result = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })

    expect(result.coldRestore).toBeUndefined()
    expect(existsSync(join(sessionDir, file))).toBe(false)
    const ownerDir = getTerminalHistoryQuarantineOwnerDir(historyDir, sessionId)
    const bundles = readdirSync(ownerDir)
    expect(bundles).toHaveLength(1)
    expect(statSync(join(ownerDir, bundles[0], file)).size).toBe(bytes)
    expect(existsSync(join(sessionDir, 'meta.json'))).toBe(true)
  })

  it('quarantines an unreadable checkpoint even when legacy scrollback restores', async () => {
    const sessionId = 'oversized-checkpoint-with-fallback'
    const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(
      join(sessionDir, 'meta.json'),
      JSON.stringify({
        cwd: '/projects/oversized',
        cols: 80,
        rows: 24,
        startedAt: '2026-07-25T10:00:00Z',
        endedAt: null,
        exitCode: null
      })
    )
    const checkpointPath = join(sessionDir, 'checkpoint.json')
    const checkpointBytes = TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES + 1
    createSparseFile(checkpointPath, checkpointBytes)
    writeFileSync(join(sessionDir, 'scrollback.bin'), 'legacy fallback\r\n')
    historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })

    const result = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })

    expect(result.coldRestore?.scrollback).toContain('legacy fallback')
    expect(existsSync(checkpointPath)).toBe(false)
    const ownerDir = getTerminalHistoryQuarantineOwnerDir(historyDir, sessionId)
    const bundles = readdirSync(ownerDir)
    expect(bundles).toHaveLength(1)
    expect(statSync(join(ownerDir, bundles[0], 'checkpoint.json')).size).toBe(checkpointBytes)
    expect(historyAdapter.getHistoryManager()!.hasWriter(sessionId)).toBe(true)
  })

  it('quarantines a malformed log when its checkpoint fallback restores', async () => {
    const sessionId = 'malformed-log-with-checkpoint'
    const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(
      join(sessionDir, 'meta.json'),
      JSON.stringify({
        cwd: '/projects/mixed-log',
        cols: 80,
        rows: 24,
        startedAt: '2026-07-25T10:00:00Z',
        endedAt: null,
        exitCode: null
      })
    )
    writeFileSync(
      join(sessionDir, 'checkpoint.json'),
      JSON.stringify({
        snapshotAnsi: 'checkpoint fallback\r\n',
        scrollbackAnsi: 'checkpoint fallback\r\n',
        rehydrateSequences: '',
        cwd: '/projects/mixed-log',
        cols: 80,
        rows: 24,
        modes: {
          bracketedPaste: false,
          mouseTracking: false,
          applicationCursor: false,
          alternateScreen: false
        },
        scrollbackLines: 1,
        generation: 1,
        checkpointedAt: '2026-07-25T10:01:00Z'
      })
    )
    const log = Buffer.concat([
      encodeLogHeader(1),
      encodeLogBatch(1, [
        { kind: 'output', data: 'only post-checkpoint copy\r\n' },
        { kind: 'resize', cols: 1_001, rows: 24 }
      ])
    ])
    writeFileSync(join(sessionDir, 'output.log'), log)
    historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })

    const result = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })

    expect(result.coldRestore?.scrollback).toContain('checkpoint fallback')
    const ownerDir = getTerminalHistoryQuarantineOwnerDir(historyDir, sessionId)
    const bundles = readdirSync(ownerDir)
    expect(bundles).toHaveLength(1)
    expect(readFileSync(join(ownerDir, bundles[0], 'output.log'))).toEqual(log)
    expect(historyAdapter.getHistoryManager()!.hasWriter(sessionId)).toBe(true)
  })

  it('keeps unreadable history suspended when a fresh adapter finds the daemon live', async () => {
    const sessionId = 'live-with-unreadable-history'
    await adapter.spawn({ cols: 80, rows: 24, sessionId })
    const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(
      join(sessionDir, 'meta.json'),
      JSON.stringify({
        cwd: '/projects/preserved',
        cols: 80,
        rows: 24,
        startedAt: '2026-07-25T10:00:00Z',
        endedAt: null,
        exitCode: null
      })
    )
    const checkpointPath = join(sessionDir, 'checkpoint.json')
    const checkpointBytes = TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES + 1
    createSparseFile(checkpointPath, checkpointBytes)
    await leaveFailedQuarantineProtection(historyDir, sessionId)
    historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
    const suspend = vi.spyOn(historyAdapter.getHistoryManager()!, 'suspendSession')

    const result = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })

    expect(result.isReattach).toBe(true)
    expect(suspend).toHaveBeenCalledWith(sessionId, expect.objectContaining({ sessionId }))
    expect(statSync(checkpointPath).size).toBe(checkpointBytes)
    expect(existsSync(getTerminalHistoryQuarantineOwnerDir(historyDir, sessionId))).toBe(false)
  })

  it('keeps protected history suspended when its files become readable before reattach', async () => {
    const sessionId = 'live-with-recovered-protection'
    await adapter.spawn({ cols: 80, rows: 24, sessionId })
    const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(
      join(sessionDir, 'meta.json'),
      JSON.stringify({
        cwd: '/projects/preserved',
        cols: 80,
        rows: 24,
        startedAt: '2026-07-25T10:00:00Z',
        endedAt: null,
        exitCode: null
      })
    )
    const checkpointPath = join(sessionDir, 'checkpoint.json')
    createSparseFile(checkpointPath, TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES + 1)
    await leaveFailedQuarantineProtection(historyDir, sessionId)
    writeFileSync(
      checkpointPath,
      JSON.stringify({
        snapshotAnsi: 'must stay protected',
        scrollbackAnsi: '',
        rehydrateSequences: '',
        cwd: '/projects/preserved',
        cols: 80,
        rows: 24,
        modes: {
          bracketedPaste: false,
          mouseTracking: false,
          applicationCursor: false,
          alternateScreen: false
        },
        scrollbackLines: 0,
        checkpointedAt: '2026-07-25T10:01:00Z'
      })
    )
    historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })

    const result = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })

    expect(result.isReattach).toBe(true)
    expect(historyAdapter.getHistoryManager()!.hasWriter(sessionId)).toBe(false)
    expect(hasTerminalHistoryRecoveryProtection(historyDir, sessionId)).toBe(true)
    expect(readFileSync(checkpointPath, 'utf8')).toContain('must stay protected')
  })

  itOnUnprivilegedPosix(
    'full-checks live recovery after a transient protection-marker write failure',
    async () => {
      const sessionId = 'live-after-marker-write-failure'
      await adapter.spawn({ cols: 80, rows: 24, sessionId })
      const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(
        join(sessionDir, 'meta.json'),
        JSON.stringify({
          cwd: '/projects/preserved',
          cols: 80,
          rows: 24,
          startedAt: '2026-07-25T10:00:00Z',
          endedAt: null,
          exitCode: null
        })
      )
      const checkpointPath = join(sessionDir, 'checkpoint.json')
      const checkpointBytes = TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES + 1
      createSparseFile(checkpointPath, checkpointBytes)
      const failedManager = new HistoryManager(historyDir)
      const recoveryFreeze = await failedManager.freezeForRecovery(sessionId)
      chmodSync(sessionDir, 0o500)
      try {
        await failedManager.openSession(sessionId, {
          cwd: '/replacement',
          cols: 80,
          rows: 24,
          recoveryFreeze,
          quarantineUnreadableRecovery: true
        })
      } finally {
        // Why finally: a leaked 0o500 dir turns teardown into a confusing EACCES instead of the real assertion failure.
        chmodSync(sessionDir, 0o700)
      }
      expect(failedManager.isSessionDisabled(sessionId)).toBe(true)
      expect(existsSync(join(sessionDir, '.unreadable-recovery'))).toBe(false)
      historyAdapter = new DaemonPtyAdapter({
        socketPath,
        tokenPath,
        historyPath: historyDir
      })

      await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })

      expect(historyAdapter.getHistoryManager()!.hasWriter(sessionId)).toBe(false)
      expect(statSync(checkpointPath).size).toBe(checkpointBytes)
    }
  )

  it('does not manage history under a canonical id adopted from another request', async () => {
    const claim = {
      digestVersion: 1 as const,
      keyId: 'key',
      identityDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      worktreeScopeDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      agent: 'codex' as const
    }
    const surface = {
      worktreeId: 'worktree',
      tabId: 'tab',
      leafId: '11111111-1111-4111-8111-111111111111',
      terminalHandle: 'term_history_claim'
    }
    const canonicalId = 'canonical-history-claim'
    await adapter.spawn({
      cols: 80,
      rows: 24,
      sessionId: canonicalId,
      agentSessionEnsure: { claim, surface }
    })
    const sessionDir = join(historyDir, getHistorySessionDirName(canonicalId))
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(
      join(sessionDir, 'meta.json'),
      JSON.stringify({
        cwd: '/projects/canonical',
        cols: 80,
        rows: 24,
        startedAt: '2026-07-25T10:00:00Z',
        endedAt: null,
        exitCode: null
      })
    )
    const checkpointPath = join(sessionDir, 'checkpoint.json')
    const checkpointBytes = TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES + 1
    createSparseFile(checkpointPath, checkpointBytes)
    await leaveFailedQuarantineProtection(historyDir, canonicalId)
    historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })

    const adopted = await historyAdapter.spawn({
      cols: 80,
      rows: 24,
      sessionId: 'different-history-request',
      agentSessionEnsure: {
        claim,
        surface: { ...surface, terminalHandle: 'term_history_adopted' }
      }
    })

    expect(adopted.id).toBe(canonicalId)
    expect(adopted.agentSessionEnsure?.disposition).toBe('adopted')
    expect(historyAdapter.getHistoryManager()!.hasWriter(canonicalId)).toBe(false)
    expect(statSync(checkpointPath).size).toBe(checkpointBytes)
  })

  it('does not register protected recovery during startup reconciliation', async () => {
    const worktreeId = 'repo-a::/wt/protected'
    const { id: sessionId } = await adapter.spawn({ cols: 80, rows: 24, worktreeId })
    const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(
      join(sessionDir, 'meta.json'),
      JSON.stringify({
        cwd: '/projects/protected',
        cols: 80,
        rows: 24,
        startedAt: '2026-07-25T10:00:00Z',
        endedAt: null,
        exitCode: null
      })
    )
    createSparseFile(join(sessionDir, 'checkpoint.json'), TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES + 1)
    await leaveFailedQuarantineProtection(historyDir, sessionId)
    historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })

    const reconciled = await historyAdapter.reconcileOnStartup(new Set([worktreeId]))

    expect(reconciled.alive).toEqual([sessionId])
    expect(historyAdapter.getHistoryManager()!.hasWriter(sessionId)).toBe(false)
  })

  it('re-anchors ordinary restorable history during startup reconciliation', async () => {
    const adapterClass = DaemonPtyAdapter as unknown as { CHECKPOINT_INTERVAL_MS: number }
    const previousInterval = adapterClass.CHECKPOINT_INTERVAL_MS
    adapterClass.CHECKPOINT_INTERVAL_MS = 100
    try {
      const worktreeId = 'repo-a::/wt/reconciled-history'
      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
      const { id: sessionId } = await historyAdapter.spawn({
        cols: 80,
        rows: 24,
        worktreeId
      })
      lastSubprocess._simulateData('before adapter restart\r\n')
      await historyAdapter.disconnectOnly()

      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
      const manager = historyAdapter.getHistoryManager()!
      const checkpointSpy = vi.spyOn(manager, 'checkpoint')
      const reconciled = await historyAdapter.reconcileOnStartup(new Set([worktreeId]))
      const internals = historyAdapter as unknown as {
        sessionsNeedingFullCheckpoint: Set<string>
      }

      expect(reconciled.alive).toEqual([sessionId])
      expect(manager.hasWriter(sessionId)).toBe(true)
      expect(internals.sessionsNeedingFullCheckpoint.has(sessionId)).toBe(true)

      // Why both: the spy fires inside takeSnapshotAndCheckpoint; the set clears only after that await returns.
      await waitFor(
        () =>
          checkpointSpy.mock.calls.some(([id]) => id === sessionId) &&
          !internals.sessionsNeedingFullCheckpoint.has(sessionId)
      )

      const checkpoint = JSON.parse(
        readFileSync(
          join(historyDir, getHistorySessionDirName(sessionId), 'checkpoint.json'),
          'utf8'
        )
      )
      expect(checkpoint.snapshotAnsi).toContain('before adapter restart')
    } finally {
      adapterClass.CHECKPOINT_INTERVAL_MS = previousInterval
    }
  })

  it('serializes explicit shutdown behind an in-progress history-aware spawn', async () => {
    const sessionId = 'spawn-shutdown-race'
    const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(
      join(sessionDir, 'meta.json'),
      JSON.stringify({
        cwd: '/projects/race',
        cols: 80,
        rows: 24,
        startedAt: '2026-07-25T10:00:00Z',
        endedAt: null,
        exitCode: null
      })
    )
    historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
    const reader = (historyAdapter as unknown as { historyReader: HistoryReader }).historyReader
    let releaseDetection!: () => void
    let detectCalls = 0
    // Why only the first call blocks: a second never-resolving promise would hang the test instead of failing it.
    vi.spyOn(reader, 'detectColdRestoreState').mockImplementation(() => {
      if (detectCalls++ > 0) {
        return Promise.resolve({ status: 'none' })
      }
      return new Promise((resolve) => {
        releaseDetection = () => resolve({ status: 'none' })
      })
    })

    const spawning = historyAdapter.spawn({ cols: 80, rows: 24, sessionId })
    await waitFor(() => releaseDetection !== undefined)
    let shutdownSettled = false
    const shuttingDown = historyAdapter
      .shutdown(sessionId, { immediate: true })
      .then(() => (shutdownSettled = true))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(shutdownSettled).toBe(false)

    releaseDetection()
    await spawning
    await shuttingDown
    expect(existsSync(sessionDir)).toBe(false)
  })

  it('revalidates a claimed canonical id after replacing a raced spawn', async () => {
    const sessionId = 'probe-race-claimed-request'
    const canonicalId = 'probe-race-claimed-canonical'
    const sessionDir = join(historyDir, getHistorySessionDirName(sessionId))
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(
      join(sessionDir, 'meta.json'),
      JSON.stringify({
        cwd: '/projects/raced',
        cols: 100,
        rows: 30,
        startedAt: '2026-04-15T10:00:00Z',
        endedAt: null,
        exitCode: null
      })
    )
    writeFileSync(join(sessionDir, 'scrollback.bin'), 'raced claimed output\r\n')
    const claim = {
      digestVersion: 1 as const,
      keyId: 'key',
      identityDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      worktreeScopeDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      agent: 'codex' as const
    }
    const surface = {
      worktreeId: 'worktree',
      tabId: 'tab',
      leafId: '11111111-1111-4111-8111-111111111111',
      terminalHandle: 'term_claim_race'
    }
    historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
    const client = (
      historyAdapter as unknown as {
        client: { request: (type: string, payload?: unknown) => Promise<unknown> }
      }
    ).client
    const originalRequest = client.request.bind(client)
    let createCalls = 0
    vi.spyOn(client, 'request').mockImplementation(async (type: string, payload?: unknown) => {
      if (type === 'getSize') {
        return { size: { cols: 100, rows: 30 } }
      }
      if (type === 'createOrAttach') {
        createCalls++
        if (createCalls === 2) {
          await adapter.spawn({
            cols: 80,
            rows: 24,
            sessionId: canonicalId,
            agentSessionEnsure: {
              claim,
              surface: { ...surface, terminalHandle: 'term_claim_race_canonical' }
            }
          })
        }
      }
      return await originalRequest(type, payload)
    })

    const result = await historyAdapter.spawn({
      cols: 80,
      rows: 24,
      sessionId,
      agentSessionEnsure: { claim, surface }
    })

    expect(createCalls).toBe(2)
    expect(result.id).toBe(canonicalId)
    expect(result.agentSessionEnsure?.disposition).toBe('adopted')
    expect(result.coldRestore).toBeUndefined()
    expect(historyAdapter.getHistoryManager()!.hasWriter(sessionId)).toBe(false)
    expect(historyAdapter.getHistoryManager()!.hasWriter(canonicalId)).toBe(false)
    expect(readFileSync(join(sessionDir, 'scrollback.bin'), 'utf8')).toContain(
      'raced claimed output'
    )
  })
})
