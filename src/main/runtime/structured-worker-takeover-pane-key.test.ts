import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'

const hostRef: { current: unknown } = { current: null }

vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const { OrcaRuntimeWithGetPtyRecordForPaneKey } =
  await import('./orca-runtime-get-pty-record-for-pane-key')
const {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} = await import('./structured-worker-identity')

const SESSION_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

function installRecord(lease: { runtimeKind: string; claimStatus: string }): void {
  hostRef.current = {
    deps: {
      store: {
        getRecord: (sessionId: string) =>
          ({
            sessionId,
            location: { executionHostId: 'local', wslDistro: null },
            lease: { ...lease, runtimeFence: 1, deathEvidence: null }
          }) as unknown as AgentSessionRecord
      }
    },
    hasSession: () => true
  }
}

function registerWorker(): string {
  const handle = mintStructuredWorkerHandle()
  structuredWorkerIdentities.register({
    handle,
    sessionId: SESSION_ID,
    agent: 'claude',
    paneKey: mintStructuredWorkerPaneKey(SESSION_ID),
    processIncarnation: structuredWorkerProcessIncarnation(SESSION_ID),
    worktreeId: 'wt_1',
    hostScope: { kind: 'local', hostId: 'local' }
  })
  return handle
}

function runtime() {
  return Object.assign(Object.create(OrcaRuntimeWithGetPtyRecordForPaneKey.prototype), {
    _orchestrationDb: null
  }) as { getStructuredWorkerPaneKeyForSession: (sessionId: string) => string | null }
}

describe('resolving a structured worker takeover by session', () => {
  beforeEach(() => {
    structuredWorkerIdentities.clear()
    hostRef.current = null
  })

  it('resolves the session to the persisted pane key that worker owns', () => {
    const handle = registerWorker()
    installRecord({ runtimeKind: 'native', claimStatus: 'live' })
    expect(runtime().getStructuredWorkerPaneKeyForSession(SESSION_ID)).toBe(
      structuredWorkerIdentities.get(handle)!.paneKey
    )
  })

  it('answers nothing for a session this runtime no longer owns', () => {
    registerWorker()
    installRecord({ runtimeKind: 'tui', claimStatus: 'live' })
    expect(runtime().getStructuredWorkerPaneKeyForSession(SESSION_ID)).toBeNull()
  })

  it('answers nothing for a session that is not an orchestration worker', () => {
    // A plain chat session owns no worker-terminal resource, so there is no ownership to
    // relinquish and nothing to mark.
    installRecord({ runtimeKind: 'native', claimStatus: 'live' })
    expect(runtime().getStructuredWorkerPaneKeyForSession(SESSION_ID)).toBeNull()
  })
})
