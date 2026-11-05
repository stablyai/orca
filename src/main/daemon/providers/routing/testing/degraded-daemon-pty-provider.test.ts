import { describe, expect, it, vi } from 'vitest'
import { DegradedDaemonPtyProvider } from '../degraded-daemon-pty-provider'
import { DEGRADED_DAEMON_RECOVERY_RETRY_MS } from '../degraded-daemon-fresh-spawn-routing'
import type { DaemonPtyAdapter } from '../../adapter/daemon-pty-adapter'
import { settledWriteStub } from '../../../../providers/settled-pty-write-stub'
import type {
  IPtyProvider,
  PtySpawnOptions,
  PtySpawnResult
} from '../../../../providers/pty-provider-contract'
import type { PtyProcessInspectionOptions } from '../../../../providers/pty-process-inspection'
import type { TerminalProcessInspection as PtyProcessInspection } from '../../../../../shared/terminal/pty/lifecycle/terminal-process-inspection'
import { readLaunchedAgentForeground } from '../../../../runtime/terminal/wait/launched-agent-foreground'
import { SessionNotFoundError } from '../../../protocol/daemon-errors'

type ProviderMock = IPtyProvider & {
  probePtyLiveness: (id: string) => Promise<boolean | null>
  inspectProcess: (
    id: string,
    options?: PtyProcessInspectionOptions
  ) => Promise<PtyProcessInspection>
  emitData: (id: string, data: string, sequenceChars?: number) => void
  emitReplay: (id: string, data: string) => void
  emitExit: (id: string, code: number) => void
  onWriteUnavailable: (callback: (payload: { id: string }) => void) => () => void
}

function createProvider(
  label: string,
  sessions: string[] = [],
  authoritativeOwnerListings = false
): ProviderMock {
  const dataListeners: ((payload: { id: string; data: string; sequenceChars?: number }) => void)[] =
    []
  const replayListeners: ((payload: { id: string; data: string }) => void)[] = []
  const exitListeners: ((payload: { id: string; code: number }) => void)[] = []
  const writeUnavailableListeners: ((payload: { id: string }) => void)[] = []
  return {
    spawn: vi.fn(async (opts: PtySpawnOptions): Promise<PtySpawnResult> => {
      const id = opts.sessionId ?? `${label}-new`
      sessions.push(id)
      return { id }
    }),
    attach: vi.fn(async () => {}),
    hasPty: vi.fn((id: string) => sessions.includes(id)),
    probePtyLiveness: vi.fn(async (id: string) => sessions.includes(id)),
    providesAgentSessionOwnerListings: vi.fn(() => authoritativeOwnerListings),
    write: vi.fn(),
    writeWithSettlement: vi.fn(settledWriteStub()),
    resize: vi.fn(),
    shutdown: vi.fn(async (id: string) => {
      const idx = sessions.indexOf(id)
      if (idx !== -1) {
        sessions.splice(idx, 1)
      }
    }),
    sendSignal: vi.fn(async () => {}),
    getCwd: vi.fn(async () => ''),
    getInitialCwd: vi.fn(async () => ''),
    clearBuffer: vi.fn(async () => {}),
    resetInputModes: vi.fn(async () => {}),
    acknowledgeDataEvent: vi.fn(),
    hasChildProcesses: vi.fn(async () => false),
    getForegroundProcess: vi.fn(async () => null),
    inspectProcess: vi.fn(async () => ({ foregroundProcess: null, hasChildProcesses: false })),
    confirmForegroundProcess: vi.fn(async () => `${label}-confirmed`),
    serialize: vi.fn(async () => '{}'),
    revive: vi.fn(async () => {}),
    listProcesses: vi.fn(async () => sessions.map((id) => ({ id, cwd: '', title: label }))),
    getDefaultShell: vi.fn(async () => '/bin/zsh'),
    getProfiles: vi.fn(async () => []),
    onData: vi.fn(
      (callback: (payload: { id: string; data: string; sequenceChars?: number }) => void) => {
        dataListeners.push(callback)
        return () => {
          const idx = dataListeners.indexOf(callback)
          if (idx !== -1) {
            dataListeners.splice(idx, 1)
          }
        }
      }
    ),
    onReplay: vi.fn((callback: (payload: { id: string; data: string }) => void) => {
      replayListeners.push(callback)
      return () => {
        const idx = replayListeners.indexOf(callback)
        if (idx !== -1) {
          replayListeners.splice(idx, 1)
        }
      }
    }),
    onExit: vi.fn((callback: (payload: { id: string; code: number }) => void) => {
      exitListeners.push(callback)
      return () => {
        const idx = exitListeners.indexOf(callback)
        if (idx !== -1) {
          exitListeners.splice(idx, 1)
        }
      }
    }),
    emitData: (id: string, data: string, sequenceChars?: number) => {
      for (const listener of dataListeners) {
        listener({ id, data, ...(sequenceChars === undefined ? {} : { sequenceChars }) })
      }
    },
    emitReplay: (id: string, data: string) => {
      for (const listener of replayListeners) {
        listener({ id, data })
      }
    },
    emitExit: (id: string, code: number) => {
      for (const listener of exitListeners) {
        listener({ id, code })
      }
    },
    onWriteUnavailable: vi.fn((callback: (payload: { id: string }) => void) => {
      writeUnavailableListeners.push(callback)
      return () => {
        const idx = writeUnavailableListeners.indexOf(callback)
        if (idx !== -1) {
          writeUnavailableListeners.splice(idx, 1)
        }
      }
    })
  }
}

function createDaemonAdapter(
  label: string,
  sessions: string[] = []
): DaemonPtyAdapter & ProviderMock {
  return {
    ...createProvider(label, sessions, true),
    protocolVersion: 13,
    supportsGitCredentialGuardHost: vi.fn(() => true),
    canProvideAuthoritativeBufferSnapshot: vi.fn(() => true),
    listSessions: vi.fn(async () => []),
    ackColdRestore: vi.fn(),
    clearTombstone: vi.fn(),
    reconcileOnStartup: vi.fn(async () => ({ alive: sessions, killed: [] })),
    dispose: vi.fn(),
    disconnectOnly: vi.fn(async () => {}),
    getActiveSessionIds: vi.fn(() => []),
    fanoutSyntheticExits: vi.fn()
  } as unknown as DaemonPtyAdapter & ProviderMock
}

it('confirms repeated stale-binding absence without falling back or spawning', async () => {
  const current = createDaemonAdapter('daemon-current')
  const legacy = createDaemonAdapter('daemon-legacy')
  const fallback = createProvider('local-fallback')
  vi.mocked(fallback.spawn).mockImplementation(async (opts) =>
    opts.attachOnly
      ? {
          id: opts.sessionId!,
          incarnationId: 'incarnation-fresh-local',
          isReattach: true
        }
      : { id: 'pty-fresh-local', incarnationId: 'incarnation-fresh-local' }
  )
  const provider = new DegradedDaemonPtyProvider({ current, legacy: [legacy], fallback })
  const attach = {
    sessionId: 'pty-persisted-missing',
    expectedIncarnationId: 'incarnation-persisted-missing',
    attachOnly: true,
    cols: 80,
    rows: 24
  } as const

  await expect(provider.spawn(attach)).rejects.toBeInstanceOf(SessionNotFoundError)
  await expect(provider.spawn(attach)).rejects.toBeInstanceOf(SessionNotFoundError)

  expect(fallback.listProcesses).toHaveBeenCalledTimes(2)
  expect(current.listProcesses).toHaveBeenCalledTimes(2)
  expect(legacy.listProcesses).toHaveBeenCalledTimes(2)
  expect(fallback.spawn).not.toHaveBeenCalled()
  expect(current.spawn).not.toHaveBeenCalled()
  expect(legacy.spawn).not.toHaveBeenCalled()

  const fresh = await provider.spawn({ cols: 80, rows: 24 })
  await expect(
    provider.spawn({
      sessionId: fresh.id,
      expectedIncarnationId: fresh.incarnationId,
      attachOnly: true,
      cols: 80,
      rows: 24
    })
  ).resolves.toMatchObject({
    id: 'pty-fresh-local',
    incarnationId: 'incarnation-fresh-local',
    isReattach: true
  })

  expect(fallback.spawn).toHaveBeenCalledTimes(2)
  expect(vi.mocked(fallback.spawn).mock.calls[0]?.[0]).not.toHaveProperty('sessionId')
  expect(vi.mocked(fallback.spawn).mock.calls[1]?.[0]).toMatchObject({
    sessionId: 'pty-fresh-local',
    attachOnly: true
  })
  expect(current.spawn).not.toHaveBeenCalled()
  expect(legacy.spawn).not.toHaveBeenCalled()
  expect(fallback.listProcesses).toHaveBeenCalledTimes(2)
  expect(current.listProcesses).toHaveBeenCalledTimes(2)
  expect(legacy.listProcesses).toHaveBeenCalledTimes(2)
})

describe('DegradedDaemonPtyProvider', () => {
  it('observes an established fresh PTY while an unrelated legacy daemon is unreachable', async () => {
    const current = createDaemonAdapter('daemon')
    const legacy = createDaemonAdapter('legacy', ['unrelated'])
    const fallback = createProvider('fallback')
    const observation = {
      ptyId: 'fallback-new',
      ptyIncarnationId: 'inc',
      authorityGeneration: 'owner',
      observationEpoch: 1,
      capturedAgeMs: 0,
      verdict: 'observed' as const,
      source: 'pty-master' as const,
      foregroundKind: 'non-shell' as const,
      processName: 'claude'
    }
    Object.assign(fallback, { supportsForegroundObservation: () => true })
    vi.mocked(fallback.inspectProcess).mockResolvedValue({
      foregroundProcess: 'claude',
      hasChildProcesses: true,
      foregroundObservation: observation
    })
    const provider = new DegradedDaemonPtyProvider({ current, legacy: [legacy], fallback })
    const fresh = await provider.spawn({ cols: 80, rows: 24 })
    vi.mocked(legacy.listProcesses).mockRejectedValue(new Error('unreachable'))
    const controller = {
      supportsForegroundObservation: (id: string) => provider.supportsForegroundObservation(id),
      inspectProcess: (id: string, options?: PtyProcessInspectionOptions) =>
        provider.inspectProcess(id, options),
      getForegroundProcess: (id: string) => provider.getForegroundProcess(id),
      listProcesses: (_host?: string, opts?: Parameters<IPtyProvider['listProcesses']>[0]) =>
        provider.listProcesses(opts)
    }

    await expect(
      readLaunchedAgentForeground(controller, { remote: false, windows: false }, fresh.id, 'claude')
    ).resolves.toBe('agent')
    expect(fallback.inspectProcess).toHaveBeenCalledWith(fresh.id, { foregroundOnly: true })
    // The target read skips the unrelated census; every other scoped read keeps it.
    await expect(
      provider.listProcesses({ ptyIds: [fresh.id], targetOwnerOnly: true })
    ).resolves.toMatchObject([{ id: fresh.id }])
    expect(legacy.listProcesses).not.toHaveBeenCalled()
    await expect(provider.listProcesses({ ptyIds: [fresh.id] })).rejects.toThrow()
    expect(provider.supportsForegroundObservation('unrouted')).toBe(false)
  })

  it('routes later fresh PTYs to the daemon after spawn health recovers', async () => {
    const current = createDaemonAdapter('daemon')
    const fallback = createProvider('fallback')
    const probeCurrentDaemonSpawn = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const provider = new DegradedDaemonPtyProvider({
      current,
      legacy: [],
      fallback,
      probeCurrentDaemonSpawn
    })
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)

    try {
      await expect(provider.recoverFreshSpawnRouting()).resolves.toBe(false)
      await provider.spawn({ cols: 80, rows: 24 })
      await expect(provider.recoverFreshSpawnRouting()).resolves.toBe(false)
      expect(probeCurrentDaemonSpawn).toHaveBeenCalledOnce()
      now.mockReturnValue(1_000 + DEGRADED_DAEMON_RECOVERY_RETRY_MS)
      await expect(provider.recoverFreshSpawnRouting()).resolves.toBe(true)
      const recovered = await provider.spawn({ cols: 80, rows: 24, worktreeId: 'wt-1' })

      expect(provider.routesFreshSpawnsToLocalProvider).toBeUndefined()
      expect(provider.isDegraded).toBe(true)
      expect(provider.supportsGitCredentialGuardHost()).toBe(true)
      expect(fallback.spawn).toHaveBeenCalledOnce()
      expect(current.spawn).toHaveBeenCalledWith({ cols: 80, rows: 24, worktreeId: 'wt-1' })
      expect(recovered.id).toBe('daemon-new')
      expect(provider.canProvideAuthoritativeBufferSnapshot(recovered.id)).toBe(true)
    } finally {
      now.mockRestore()
    }
  })

  it('does not retain recovered daemon ownership after exit beats the spawn reply', async () => {
    const current = createDaemonAdapter('daemon')
    const provider = new DegradedDaemonPtyProvider({
      current,
      legacy: [],
      fallback: createProvider('fallback'),
      probeCurrentDaemonSpawn: vi.fn(async () => true)
    })
    vi.mocked(current.spawn).mockImplementation(async () => {
      current.emitExit('daemon-fast-exit', 0)
      return { id: 'daemon-fast-exit', exitedBeforeSpawnReply: true }
    })

    await provider.recoverFreshSpawnRouting()
    await expect(provider.spawn({ cols: 80, rows: 24 })).resolves.toMatchObject({
      id: 'daemon-fast-exit',
      exitedBeforeSpawnReply: true
    })

    expect(provider.getSessionIdsRoutedTo('current-daemon')).toEqual([])
  })
})
