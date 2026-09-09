import { vi } from 'vitest'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { settledWriteStub } from '../providers/settled-pty-write-stub'
import type { PtyBackgroundStreamEvent, PtySpawnOptions, PtySpawnResult } from '../providers/types'
import {
  AGENT_SESSION_CLAIM_DAEMON_PROTOCOL_VERSION,
  AGENT_SESSION_CREATE_OPERATION_DAEMON_PROTOCOL_VERSION,
  GIT_CREDENTIAL_GUARD_HOST_PROTOCOL_VERSION
} from './types'
import { SNAPSHOT_SERIALIZER_FIDELITY_DAEMON_PROTOCOL_VERSION } from './daemon-protocol-version'

type AdapterMock = DaemonPtyAdapter & {
  emitData: (id: string, data: string, sequenceChars?: number) => void
  emitBackground: (event: PtyBackgroundStreamEvent) => void
  emitExit: (id: string, code: number, incarnationId?: string) => void
  emitIdentityChange: () => void
  triggerWriteUnavailable: (id: string) => void
}

export function createAdapter(
  label: string,
  sessions: string[] = [],
  protocolVersion = GIT_CREDENTIAL_GUARD_HOST_PROTOCOL_VERSION
): AdapterMock {
  const writes: { id: string; data: string }[] = []
  const dataListeners: ((payload: { id: string; data: string; sequenceChars?: number }) => void)[] =
    []
  const backgroundListeners: ((payload: PtyBackgroundStreamEvent) => void)[] = []
  const writeUnavailableListeners: ((payload: { id: string }) => void)[] = []
  const exitListeners: ((payload: { id: string; code: number; incarnationId?: string }) => void)[] =
    []
  const identityChangeListeners: (() => void)[] = []
  return {
    protocolVersion,
    retireIfIdle: vi.fn(async () => false),
    canHandoffHistoryTo: vi.fn(async () => true),
    supportsGitCredentialGuardHost: () =>
      protocolVersion >= GIT_CREDENTIAL_GUARD_HOST_PROTOCOL_VERSION,
    supportsAgentSessionClaims: () =>
      protocolVersion >= AGENT_SESSION_CLAIM_DAEMON_PROTOCOL_VERSION,
    supportsAgentSessionCreateOperations: () =>
      protocolVersion >= AGENT_SESSION_CREATE_OPERATION_DAEMON_PROTOCOL_VERSION,
    providesAgentSessionOwnerListings: () =>
      protocolVersion >= AGENT_SESSION_CLAIM_DAEMON_PROTOCOL_VERSION,
    canProvideAuthoritativeBufferSnapshot: () =>
      protocolVersion >= SNAPSHOT_SERIALIZER_FIDELITY_DAEMON_PROTOCOL_VERSION,
    spawn: vi.fn(async (opts: PtySpawnOptions): Promise<PtySpawnResult> => {
      const id = opts.sessionId ?? `${label}-new`
      sessions.push(id)
      return { id }
    }),
    listProcesses: vi.fn(async () =>
      sessions.map((id) => ({
        id,
        cwd: '',
        title: label
      }))
    ),
    hasPty: vi.fn((id: string) => sessions.includes(id)),
    probePtyLiveness: vi.fn(async (id: string) => sessions.includes(id)),
    write: vi.fn((id: string, data: string) => {
      writes.push({ id, data })
    }),
    writeWithSettlement: vi.fn(settledWriteStub()),
    resize: vi.fn(),
    setPtyBackgrounded: vi.fn(),
    getBufferSnapshot: vi.fn(async () => null),
    shutdown: vi.fn(async (id: string) => {
      const idx = sessions.indexOf(id)
      if (idx !== -1) {
        sessions.splice(idx, 1)
      }
    }),
    attach: vi.fn(async () => {}),
    sendSignal: vi.fn(async () => {}),
    getCwd: vi.fn(async () => ''),
    getInitialCwd: vi.fn(async () => ''),
    clearBuffer: vi.fn(async () => {}),
    acknowledgeDataEvent: vi.fn(),
    hasChildProcesses: vi.fn(async () => false),
    getForegroundProcess: vi.fn(async () => null),
    inspectProcess: vi.fn(async () => ({ foregroundProcess: null, hasChildProcesses: false })),
    confirmForegroundProcess: vi.fn(async () => `${label}-confirmed`),
    serialize: vi.fn(async () => '{}'),
    revive: vi.fn(async () => {}),
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
    onBackgroundStreamEvent: vi.fn((callback: (payload: PtyBackgroundStreamEvent) => void) => {
      backgroundListeners.push(callback)
      return () => {
        const idx = backgroundListeners.indexOf(callback)
        if (idx !== -1) {
          backgroundListeners.splice(idx, 1)
        }
      }
    }),
    onWriteUnavailable: vi.fn((callback: (payload: { id: string }) => void) => {
      writeUnavailableListeners.push(callback)
      return () => {
        const idx = writeUnavailableListeners.indexOf(callback)
        if (idx !== -1) {
          writeUnavailableListeners.splice(idx, 1)
        }
      }
    }),
    onExit: vi.fn(
      (callback: (payload: { id: string; code: number; incarnationId?: string }) => void) => {
        exitListeners.push(callback)
        return () => {
          const idx = exitListeners.indexOf(callback)
          if (idx !== -1) {
            exitListeners.splice(idx, 1)
          }
        }
      }
    ),
    onDaemonIdentityChanged: vi.fn((callback: () => void) => {
      identityChangeListeners.push(callback)
      return () => {
        const idx = identityChangeListeners.indexOf(callback)
        if (idx !== -1) {
          identityChangeListeners.splice(idx, 1)
        }
      }
    }),
    ackColdRestore: vi.fn(),
    clearTombstone: vi.fn(),
    dispose: vi.fn(),
    disconnectOnly: vi.fn(async () => {}),
    emitData: (id: string, data: string, sequenceChars?: number) => {
      for (const listener of dataListeners) {
        listener({ id, data, ...(sequenceChars === undefined ? {} : { sequenceChars }) })
      }
    },
    emitBackground: (event: PtyBackgroundStreamEvent) => {
      for (const listener of backgroundListeners) {
        listener(event)
      }
    },
    emitExit: (id: string, code: number, incarnationId?: string) => {
      for (const listener of exitListeners) {
        listener({ id, code, ...(incarnationId ? { incarnationId } : {}) })
      }
    },
    emitIdentityChange: () => identityChangeListeners.forEach((listener) => listener()),
    triggerWriteUnavailable: (id: string) => {
      for (const listener of writeUnavailableListeners) {
        listener({ id })
      }
    },
    _writes: writes
  } as unknown as AdapterMock
}
