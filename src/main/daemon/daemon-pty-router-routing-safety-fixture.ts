import { vi } from 'vitest'
import type { PtyProcessInfo, PtySpawnOptions } from '../providers/types'
import type { DaemonEndpointIdentity } from './daemon-hello-protocol'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'

export type AdapterHarness = {
  adapter: DaemonPtyAdapter
  emitData: (sessionId: string, data: string) => void
  emitIdentityChange: (previous: DaemonEndpointIdentity, current: DaemonEndpointIdentity) => void
  emitExit: (sessionId: string, code: number) => void
  emitWriteUnavailable: (sessionId: string) => void
  setIdentity: (identity: DaemonEndpointIdentity) => void
}

export function identity(label: string, pid: number): DaemonEndpointIdentity {
  return {
    pid,
    startedAtMs: pid * 1_000,
    launchNonce: `${label}-${pid}`
  }
}

export function createAdapter(
  label: string,
  sessions: string[] = [],
  reconcileResult: { alive: string[]; killed: string[] } = { alive: [], killed: [] }
): AdapterHarness {
  let daemonIdentity = identity(label, label === 'current' ? 20 : 10)
  const identityListeners: ((event: {
    previous: DaemonEndpointIdentity
    current: DaemonEndpointIdentity
  }) => void)[] = []
  const dataListeners: ((payload: { id: string; data: string }) => void)[] = []
  const exitListeners: ((payload: { id: string; code: number }) => void)[] = []
  const writeUnavailableListeners: ((payload: { id: string }) => void)[] = []
  const adapter = {
    protocolVersion: label === 'current' ? 30 : 29,
    getLastAuthenticatedDaemonIdentity: vi.fn(() => ({ ...daemonIdentity })),
    matchesLastAuthenticatedDaemonIdentity: vi.fn(
      (candidate: DaemonEndpointIdentity | null) =>
        candidate !== null &&
        candidate.pid === daemonIdentity.pid &&
        candidate.startedAtMs === daemonIdentity.startedAtMs &&
        candidate.launchNonce === daemonIdentity.launchNonce
    ),
    onDaemonIdentityChanged: vi.fn(
      (
        listener: (event: {
          previous: DaemonEndpointIdentity
          current: DaemonEndpointIdentity
        }) => void
      ) => {
        identityListeners.push(listener)
        return () => {}
      }
    ),
    listProcesses: vi.fn(
      async (): Promise<PtyProcessInfo[]> => sessions.map((id) => ({ id, cwd: '', title: label }))
    ),
    spawn: vi.fn(async (opts: PtySpawnOptions) => ({
      id: opts.sessionId ?? `${label}-fresh`
    })),
    probePtyLiveness: vi.fn(async (id: string) => sessions.includes(id)),
    hasPty: vi.fn((id: string) => sessions.includes(id)),
    shutdown: vi.fn(async () => {}),
    sendSignal: vi.fn(async () => {}),
    getBufferSnapshot: vi.fn(async () => null),
    ackColdRestore: vi.fn(),
    reconcileOnStartup: vi.fn(async () => reconcileResult),
    onData: vi.fn((listener: (payload: { id: string; data: string }) => void) => {
      dataListeners.push(listener)
      return () => {}
    }),
    onExit: vi.fn((listener: (payload: { id: string; code: number }) => void) => {
      exitListeners.push(listener)
      return () => {}
    }),
    onBackgroundStreamEvent: vi.fn(() => () => {}),
    onWriteUnavailable: vi.fn((listener: (payload: { id: string }) => void) => {
      writeUnavailableListeners.push(listener)
      return () => {
        const index = writeUnavailableListeners.indexOf(listener)
        if (index !== -1) {
          writeUnavailableListeners.splice(index, 1)
        }
      }
    }),
    dispose: vi.fn(),
    disconnectOnly: vi.fn(async () => {})
  } as unknown as DaemonPtyAdapter

  return {
    adapter,
    emitData: (sessionId, data) => {
      for (const listener of dataListeners) {
        listener({ id: sessionId, data })
      }
    },
    setIdentity: (next) => {
      daemonIdentity = next
    },
    emitIdentityChange: (previous, current) => {
      for (const listener of identityListeners) {
        listener({ previous, current })
      }
    },
    emitExit: (sessionId, code) => {
      for (const listener of exitListeners) {
        listener({ id: sessionId, code })
      }
    },
    emitWriteUnavailable: (sessionId) => {
      for (const listener of writeUnavailableListeners) {
        listener({ id: sessionId })
      }
    }
  }
}
