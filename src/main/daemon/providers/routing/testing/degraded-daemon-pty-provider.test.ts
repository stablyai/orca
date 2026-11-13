import { describe, expect, it, vi } from 'vitest'
import { DegradedDaemonPtyProvider } from '../degraded-daemon-pty-provider'

import type { DaemonPtyAdapter } from '../../adapter/daemon-pty-adapter'
import { settledWriteStub } from '../../../../providers/testing/settled-pty-write-stub'
import type { IPtyProvider, PtySpawnOptions } from '../../../../providers/pty/provider-contract'
import type { PtySpawnResult } from '../../../../providers/pty/spawn-result'
import type { PtyProcessInspectionOptions } from '../../../../providers/pty/process-inspection'
import type { TerminalProcessInspection as PtyProcessInspection } from '../../../../../shared/terminal/pty/lifecycle/terminal-process-inspection'

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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the degraded router reaches only these adapter members.
  return {
    ...createProvider(label, sessions, true),
    protocolVersion: 13,
    supportsGitCredentialGuardHost: vi.fn(() => true),
    canProvideAuthoritativeBufferSnapshot: vi.fn(() => true),
    listSessions: vi.fn(async () => []),
    ackColdRestore: vi.fn(),
    clearTombstone: vi.fn(),
    reportFocusLost: vi.fn(async () => {}),
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
