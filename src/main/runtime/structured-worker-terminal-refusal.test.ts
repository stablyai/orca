import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'

const hostRef: { current: unknown } = { current: null }

vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const { structuredWorkerTerminalRefusal } = await import('./structured-worker-terminal-refusal')
const {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} = await import('./structured-worker-identity')

const SESSION_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

function installRecord(): void {
  hostRef.current = {
    deps: {
      store: {
        getRecord: (sessionId: string) =>
          ({
            sessionId,
            location: { executionHostId: 'local', wslDistro: null },
            lease: {
              runtimeKind: 'native',
              claimStatus: 'live',
              runtimeFence: 1,
              deathEvidence: null
            }
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

describe('the refusal a terminal verb gives a structured worker handle', () => {
  beforeEach(() => {
    structuredWorkerIdentities.clear()
    hostRef.current = null
  })

  it('says the handle is an agent session, not that it went stale', () => {
    // `terminal_handle_stale` is a claim the handle died. It never did — the session is live and
    // has no terminal — so callers went looking for a remint that cannot exist.
    const handle = registerWorker()
    installRecord()
    const error = structuredWorkerTerminalRefusal(handle, null)
    expect(error.message).not.toContain('terminal_handle_stale')
    expect((error as { code?: string }).code).toBe('terminal_unsupported_for_agent_session')
  })

  it('points at the structured equivalents rather than just failing', () => {
    const handle = registerWorker()
    installRecord()
    const message = structuredWorkerTerminalRefusal(handle, null).message
    expect(message).toContain('orca terminal read')
    expect(message).toContain('worker-read --source transcript')
    expect(message).toContain('orca orchestration send')
  })

  it('keeps the stale error for a PTY handle, which really can go stale', () => {
    expect(structuredWorkerTerminalRefusal('term_gone', null).message).toBe('terminal_handle_stale')
  })

  it('keeps the stale error for a session this runtime no longer owns', () => {
    // Once the lease moves or the session is released the handle IS dead, and saying so is right.
    registerWorker()
    hostRef.current = null
    expect(structuredWorkerTerminalRefusal('term_gone', null).message).toBe('terminal_handle_stale')
  })
})
