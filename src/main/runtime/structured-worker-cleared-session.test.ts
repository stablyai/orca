/**
 * A structured worker the user `/clear`ed is continued by the successor session. Every read,
 * observation, status and stop of the worker must reach that successor — the one doing the work —
 * the same way its mail already does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const { readStructuredWorkerTerminal } = await import('./structured-worker-terminal-read')
const { observeStructuredWorker, resolveStructuredWorkerAuthority } =
  await import('./structured-worker-authority')
const { structuredWorkerMailSessionId } =
  await import('./orchestration/structured-session-mail-target')
const { stopStructuredWorker, readStructuredWorkerJournal, captureStructuredWorkerArchive } =
  await import('./rpc/methods/orchestration-structured-worker-lifecycle')
const { OrcaRuntimeService } = await import('./orca-runtime')
const { AGENT_SESSION_NOT_ATTACHED } =
  await import('../native-chat/agent-session-wire/structured-agent-session-mutation-admission')
const {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} = await import('./structured-worker-identity')

const MINTED = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const SUCCESSOR = 'clear-a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

function message(id: string, text: string): AgentJournalRenderItem {
  return {
    itemId: id,
    revision: 1,
    observedAt: 1,
    sequence: 1,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
  }
}

function record(sessionId: string, closed: boolean): AgentSessionRecord {
  const base = agentSessionRecordFixture(
    agentSessionLeaseFixture({
      sessionId,
      claimStatus: closed ? 'released' : 'live',
      deathEvidence: closed ? { kind: 'exit-observed', detail: 'closed', observedAt: 2 } : null
    })
  )
  return {
    ...base,
    location: { ...base.location, workspaceId: 'wt_1' },
    ...(sessionId === MINTED
      ? {
          conversationCommand: {
            command: 'clear',
            runtimeFence: 7,
            operationId: 'op-clear',
            callerKey: 'renderer',
            phase: 'committed',
            state: 'completed',
            replacementSessionId: SUCCESSOR
          }
        }
      : {})
  }
}

const records = new Map<string, AgentSessionRecord>()
/** Set to make the record store unreadable. */
let storeFailure: Error | null = null
const closed: string[] = []
const historyAsked: string[] = []

/** As the clear RPC leaves it: the minted session closed, the successor live and working. */
function installClearedWorkerHost(): void {
  storeFailure = null
  records.clear()
  records.set(MINTED, record(MINTED, true))
  records.set(SUCCESSOR, record(SUCCESSOR, false))
  hostRef.current = {
    deps: {
      store: {
        getRecord: (id: string) => {
          if (storeFailure) {
            throw storeFailure
          }
          return records.get(id) ?? null
        },
        listRecords: () => [...records.values()]
      }
    },
    hasSession: (id: string) => records.get(id)?.lease.claimStatus === 'live',
    journalSnapshot: (id: string) => {
      if (records.get(id)?.lease.claimStatus !== 'live') {
        throw new Error(AGENT_SESSION_NOT_ATTACHED.code)
      }
      return { items: [message(`${id}-1`, 'idle')] }
    },
    close: async (id: string) => {
      closed.push(id)
      records.set(id, record(id, true))
    },
    history: ({ sessionId }: { sessionId: string }) => {
      historyAsked.push(sessionId)
      return {
        page: {
          items: [
            message(
              `${sessionId}-1`,
              sessionId === MINTED ? 'PRE-CLEAR (stale)' : 'POST-CLEAR (live work)'
            )
          ],
          hasOlder: false
        }
      }
    }
  }
}

function registerWorker() {
  return structuredWorkerIdentities.register({
    handle: mintStructuredWorkerHandle(),
    sessionId: MINTED,
    agent: 'claude',
    paneKey: mintStructuredWorkerPaneKey(MINTED),
    processIncarnation: structuredWorkerProcessIncarnation(MINTED),
    worktreeId: 'wt_1',
    hostScope: { kind: 'local', hostId: 'local' }
  })
}

describe('a structured worker continued by /clear is served by its successor', () => {
  beforeEach(() => {
    structuredWorkerIdentities.clear()
    closed.length = 0
    historyAsked.length = 0
    installClearedWorkerHost()
  })

  it('mail already follows the lineage (the control)', () => {
    expect(structuredWorkerMailSessionId(MINTED)).toBe(SUCCESSOR)
  })

  it('keeps its authority though the minted session was closed by the clear', () => {
    const identity = registerWorker()
    expect(resolveStructuredWorkerAuthority(identity.handle, null)?.record.sessionId).toBe(
      SUCCESSOR
    )
  })

  it('observes the successor', () => {
    expect(observeStructuredWorker(registerWorker())).toEqual({ status: 'live' })
  })

  it('terminal read serves the successor', () => {
    const identity = registerWorker()
    const read = readStructuredWorkerTerminal({ handle: identity.handle, db: null })
    expect(historyAsked).toEqual([SUCCESSOR])
    expect(read?.status).toBe('running')
    expect(JSON.stringify(read)).toContain('POST-CLEAR')
  })

  it('worker-read serves the successor', () => {
    const read = readStructuredWorkerJournal({
      identity: registerWorker(),
      dispatchId: 'ctx_1',
      workerState: 'running',
      liveness: 'live',
      agent: 'claude'
    })
    expect(JSON.stringify(read)).toContain('POST-CLEAR')
    expect(JSON.stringify(read)).not.toContain('PRE-CLEAR')
  })

  it('the release archive freezes the successor', () => {
    const archive = captureStructuredWorkerArchive(registerWorker(), 'claude')
    expect(JSON.stringify(archive)).toContain('POST-CLEAR')
  })

  it('worker-stop closes the successor that is doing the work', async () => {
    const stop = await stopStructuredWorker(registerWorker(), 'ctx_1')
    expect(closed).toEqual([SUCCESSOR])
    expect(stop.stopped).toBe(true)
  })

  it("agent status is the successor's", () => {
    const identity = registerWorker()
    expect(new OrcaRuntimeService().getAgentStatusForHandle(identity.handle)).toBe('idle')
  })
})

describe('terminal read by the session address an agent is shown', () => {
  beforeEach(() => {
    structuredWorkerIdentities.clear()
    historyAsked.length = 0
    installClearedWorkerHost()
  })

  it('reads a worker at session:<its id>, served by the session running it', () => {
    registerWorker()
    const read = readStructuredWorkerTerminal({ handle: `session:${MINTED}`, db: null })
    expect(read?.handle).toBe(`session:${MINTED}`)
    expect(historyAsked).toEqual([SUCCESSOR])
  })

  it('reads a chat, in the same shape a terminal read has', () => {
    // No worker registered: MINTED is an ordinary chat the user cleared.
    const read = readStructuredWorkerTerminal({ handle: `session:${MINTED}`, db: null })
    expect(historyAsked).toEqual([SUCCESSOR])
    expect(read).toMatchObject({ status: 'running', nextCursor: null, truncated: false })
    expect(read?.tail.join('\n')).toContain('POST-CLEAR')
  })

  it('refuses a cursor, as for any structured session', () => {
    expect(() =>
      readStructuredWorkerTerminal({ handle: `session:${MINTED}`, db: null, cursor: 0 })
    ).toThrow(/without a cursor/)
  })

  it('leaves an address naming no session to the terminal lookup', () => {
    expect(
      readStructuredWorkerTerminal({
        handle: 'session:9e1d2c3b-4a5f-4e6d-8c7b-6a5f4e3d2c1b',
        db: null
      })
    ).toBeNull()
  })
})

describe('one lineage walk, one failure contract', () => {
  beforeEach(() => {
    structuredWorkerIdentities.clear()
    closed.length = 0
    historyAsked.length = 0
    installClearedWorkerHost()
  })

  it('refuses when the record store cannot be read, instead of serving the pre-clear session', async () => {
    const identity = registerWorker()
    storeFailure = new Error('disk gone')

    expect(() =>
      readStructuredWorkerJournal({
        identity,
        dispatchId: 'ctx_1',
        workerState: 'running',
        liveness: 'live',
        agent: 'claude'
      })
    ).toThrow(expect.objectContaining({ code: 'session_caller_not_live' }))
    await expect(stopStructuredWorker(identity, 'ctx_1')).rejects.toMatchObject({
      code: 'session_caller_not_live'
    })
    expect(historyAsked).toEqual([])
    expect(closed).toEqual([])
  })

  it('refuses a chat on another host with the typed host-boundary refusal', () => {
    const successor = records.get(SUCCESSOR)!
    records.set(SUCCESSOR, {
      ...successor,
      location: { ...successor.location, executionHostId: 'ssh:box' }
    })

    expect(() => readStructuredWorkerTerminal({ handle: `session:${MINTED}`, db: null })).toThrow(
      expect.objectContaining({ code: 'session_caller_host_boundary' })
    )
    // Mail maps the same verdict to "not deliverable here".
    expect(structuredWorkerMailSessionId(MINTED)).toBeNull()
  })
})
