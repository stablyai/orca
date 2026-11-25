import '../../../pty-subprocess/testing/mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonPtyAdapter } from '../../adapter/daemon-pty-adapter'
import { FinalCheckpointPreservationError } from '../../adapter/daemon-pty-lifecycle-errors'
import { DaemonProtocolError } from '../../../protocol/daemon-errors'
import { DaemonServer } from '../../../server/daemon-server'
import { getDaemonSocketPath } from '../../../launch/daemon-spawner'
import type { DaemonFileLog } from '../../../observability/daemon-file-log'
import { HistoryReader } from '../../../history/restoration/history-reader'
import type { HistoryCheckpointResult } from '../../../history/storage/terminal-history-manager-options'
import type { SubprocessHandle } from '../../../sessions/session-subprocess-handle'

function createMockSubprocess(): SubprocessHandle & { emitData: (data: string) => void } {
  let onData: ((data: string) => void) | undefined
  let onExit: ((code: number) => void) | undefined
  return {
    pid: 999_999_999,
    getForegroundProcess: vi.fn(() => null),
    confirmShellForeground: vi.fn(async () => false),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => setTimeout(() => onExit?.(0), 1)),
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: vi.fn(() => onExit?.(137)),
    signal: vi.fn(),
    onData(callback) {
      onData = callback
    },
    onExit(callback) {
      onExit = callback
    },
    dispose: vi.fn(),
    emitData(data) {
      onData?.(data)
    }
  }
}

describe('Sleep must not retire a terminal whose final history checkpoint did not commit', () => {
  let dir: string
  let server: DaemonServer
  let adapter: DaemonPtyAdapter
  let subprocesses: ReturnType<typeof createMockSubprocess>[]

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-final-checkpoint-preserve-'))
    subprocesses = []
    const log: DaemonFileLog = { log: () => {}, close: () => {} }
    server = new DaemonServer({
      socketPath: getDaemonSocketPath(dir),
      tokenPath: join(dir, 'test.token'),
      log,
      spawnSubprocess: () => {
        const subprocess = createMockSubprocess()
        subprocesses.push(subprocess)
        return subprocess
      }
    })
    await server.start()
    adapter = new DaemonPtyAdapter({
      socketPath: getDaemonSocketPath(dir),
      tokenPath: join(dir, 'test.token'),
      historyPath: join(dir, 'history')
    })
  })

  afterEach(async () => {
    if (adapter) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: protected fields the test must drain before teardown; they are declared on the adapter class itself.
      const internals = adapter as unknown as {
        checkpointInFlight: Promise<void> | null
        stopCheckpointTimer: () => void
      }
      await internals.checkpointInFlight
      internals.stopCheckpointTimer()
      await internals.checkpointInFlight
      await adapter.getHistoryManager()?.dispose()
      adapter.dispose()
    }
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  async function spawnWithOutput(sessionId: string, output: string): Promise<string> {
    const { id } = await adapter.spawn({ cols: 80, rows: 24, sessionId, cwd: '/tmp' })
    subprocesses.at(-1)!.emitData(output)
    return id
  }

  function mockFinalCheckpoint(result: HistoryCheckpointResult) {
    const manager = adapter.getHistoryManager()
    expect(manager).not.toBeNull()
    return vi.spyOn(manager!, 'checkpoint').mockImplementation(async () => result)
  }

  function mockTakePendingOutput(impl: () => Promise<unknown>): void {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the adapter's private RPC client; the test swaps one request type to inject daemon-side failures.
    const internals = adapter as unknown as {
      client: {
        request: (type: string, payload?: unknown, timeoutMs?: number) => Promise<unknown>
      }
    }
    const client = internals.client
    const original = client.request.bind(client)
    vi.spyOn(client, 'request').mockImplementation(
      async (type: string, payload?: unknown, timeoutMs?: number) => {
        if (type === 'takePendingOutput') {
          return await impl()
        }
        return await original(type, payload, timeoutMs)
      }
    )
  }

  async function onDisk(sessionId: string): Promise<string> {
    const restore = await new HistoryReader(join(dir, 'history')).detectColdRestore(sessionId, {
      ignoreCleanEnd: true
    })
    return `${restore?.scrollbackAnsi ?? ''}${restore?.snapshotAnsi ?? ''}`
  }

  it('commits the final checkpoint before requesting termination', async () => {
    const id = await spawnWithOutput('committed-session', 'LATEST-TERMINAL-MARKER\r\n')

    await adapter.shutdown(id, { immediate: true, keepHistory: true })

    expect(adapter.hasPty(id)).toBe(false)
    expect(await onDisk(id)).toContain('LATEST-TERMINAL-MARKER')
  })

  it('keeps the live terminal when the final checkpoint is retryable', async () => {
    const id = await spawnWithOutput('retryable-session', 'LATEST-TERMINAL-MARKER\r\n')
    mockFinalCheckpoint('retryable')

    await expect(
      adapter.shutdown(id, { immediate: true, keepHistory: true })
    ).rejects.toBeInstanceOf(FinalCheckpointPreservationError)

    expect(adapter.hasPty(id)).toBe(true)
    expect(await adapter.probePtyLiveness(id)).toBe(true)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: protected retry sets the fix requires; asserting them directly is the point of the test.
    const internals = adapter as unknown as {
      sessionsNeedingFullCheckpoint: Set<string>
      sessionsNeedingLiveCheckpoint: Set<string>
    }
    // The heavy-retry marker is cleared, but the live marker must survive: records drained into
    // the failed take exist only in the emulator until a later pass commits a live snapshot.
    expect(internals.sessionsNeedingFullCheckpoint.has(id)).toBe(false)
    expect(internals.sessionsNeedingLiveCheckpoint.has(id)).toBe(true)
  })

  function checkpointRecoveryState() {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: declared protected state exposed to drive real periodic recovery passes.
    return adapter as unknown as {
      checkpointDirtySessions: () => Promise<void>
      lastFullCheckpointAt: Map<string, number>
      dirtySessionVersions: Map<string, number>
      sessionsNeedingLiveCheckpoint: Set<string>
      stopCheckpointTimer: () => void
    }
  }

  it('recovers drained output from the live screen after a final write throws', async () => {
    const id = await spawnWithOutput('throw-then-commit-session', 'BASELINE-MARKER\r\n')
    await checkpointRecoveryState().checkpointDirtySessions()
    subprocesses.at(-1)!.emitData('DRAINED-TERMINAL-MARKER\r\n')
    const checkpointSpy = vi
      .spyOn(adapter.getHistoryManager()!, 'checkpoint')
      .mockRejectedValueOnce(new Error('injected checkpoint failure after drain'))

    await expect(
      adapter.shutdown(id, { immediate: true, keepHistory: true })
    ).rejects.toBeInstanceOf(FinalCheckpointPreservationError)
    expect(adapter.hasPty(id)).toBe(true)
    checkpointSpy.mockRestore()

    await adapter.shutdown(id, { immediate: true, keepHistory: true })

    expect(adapter.hasPty(id)).toBe(false)
    expect(await onDisk(id)).toContain('DRAINED-TERMINAL-MARKER')
  })

  it('keeps empty periodic passes dirty until a live snapshot recovers rejected Sleep', async () => {
    const id = await spawnWithOutput('retry-then-commit-session', 'LATEST-TERMINAL-MARKER\r\n')
    const checkpointSpy = mockFinalCheckpoint('retryable')

    await expect(
      adapter.shutdown(id, { immediate: true, keepHistory: true })
    ).rejects.toBeInstanceOf(FinalCheckpointPreservationError)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: protected retry sets the fix requires; asserting them directly is the point of the test.
    const internals = adapter as unknown as {
      sessionsNeedingLiveCheckpoint: Set<string>
    }
    expect(internals.sessionsNeedingLiveCheckpoint.has(id)).toBe(true)

    const state = checkpointRecoveryState()
    state.stopCheckpointTimer()
    await state.checkpointDirtySessions()
    expect(state.dirtySessionVersions.has(id)).toBe(true)
    expect(await onDisk(id)).not.toContain('LATEST-TERMINAL-MARKER')
    state.lastFullCheckpointAt.set(id, 0)
    await state.checkpointDirtySessions()
    expect(state.dirtySessionVersions.has(id)).toBe(true)
    expect(state.sessionsNeedingLiveCheckpoint.has(id)).toBe(true)
    expect(state.lastFullCheckpointAt.get(id)).toBeGreaterThan(0)

    checkpointSpy.mockRestore()
    state.lastFullCheckpointAt.set(id, 0)
    await state.checkpointDirtySessions()
    expect(adapter.hasPty(id)).toBe(true)
    expect(state.dirtySessionVersions.has(id)).toBe(false)
    expect(state.sessionsNeedingLiveCheckpoint.has(id)).toBe(false)
    expect(await onDisk(id)).toContain('LATEST-TERMINAL-MARKER')
    await adapter.shutdown(id, { immediate: true, keepHistory: true })

    expect(adapter.hasPty(id)).toBe(false)
    expect(internals.sessionsNeedingLiveCheckpoint.has(id)).toBe(false)
    expect(await onDisk(id)).toContain('LATEST-TERMINAL-MARKER')
  })

  it('keeps the live terminal when the snapshot RPC rejects', async () => {
    const id = await spawnWithOutput('rpc-reject-session', 'LATEST-TERMINAL-MARKER\r\n')
    mockTakePendingOutput(async () => {
      throw new DaemonProtocolError('injected transport failure')
    })

    await expect(
      adapter.shutdown(id, { immediate: true, keepHistory: true })
    ).rejects.toBeInstanceOf(FinalCheckpointPreservationError)

    expect(adapter.hasPty(id)).toBe(true)
    expect(await adapter.probePtyLiveness(id)).toBe(true)
  })

  it('keeps the live terminal when the daemon returns no snapshot', async () => {
    const id = await spawnWithOutput('no-snapshot-session', 'LATEST-TERMINAL-MARKER\r\n')
    mockTakePendingOutput(async () => null)

    await expect(
      adapter.shutdown(id, { immediate: true, keepHistory: true })
    ).rejects.toBeInstanceOf(FinalCheckpointPreservationError)

    expect(adapter.hasPty(id)).toBe(true)
  })

  it('keeps the live terminal when history writes are unavailable', async () => {
    const id = await spawnWithOutput('unavailable-session', 'LATEST-TERMINAL-MARKER\r\n')
    mockFinalCheckpoint('unavailable')

    await expect(
      adapter.shutdown(id, { immediate: true, keepHistory: true })
    ).rejects.toBeInstanceOf(FinalCheckpointPreservationError)

    expect(adapter.hasPty(id)).toBe(true)
  })

  it('keeps the live terminal when the snapshot response cannot cross the wire', async () => {
    const id = await spawnWithOutput('oversized-session', 'LATEST-TERMINAL-MARKER\r\n')
    mockTakePendingOutput(async () => {
      throw new DaemonProtocolError(
        'NDJSON line exceeds max 16777216 bytes (20971520 bytes encoded)'
      )
    })

    await expect(
      adapter.shutdown(id, { immediate: true, keepHistory: true })
    ).rejects.toBeInstanceOf(FinalCheckpointPreservationError)

    expect(adapter.hasPty(id)).toBe(true)
  })
})
