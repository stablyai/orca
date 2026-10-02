/**
 * A structured worker the user `/clear`ed is continued by the successor session. Every read,
 * observation, status and stop of the worker must reach that successor — the one doing the work —
 * the same way its mail already does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { FleetAgentStatusEvidence } from '../../shared/orchestration-fleet-agent-status-evidence'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../shared/structured-agent-session-projection'
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
const { OrchestrationDb } = await import('./orchestration/db')
const { structuredWorkerOwesWork } = await import('./structured-worker-custody')
const { projectFleetWorker, projectWorkerFleet } =
  await import('./rpc/methods/orchestration/worker/worker-list-projection')
const { inspectWorkerTerminal } =
  await import('./rpc/methods/orchestration/worker/worker-observation')
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
/** Set to make journal history unreadable. */
let historyFailure: Error | null = null
const closed: string[] = []
const historyAsked: string[] = []
const journalReads: string[] = []

/** As the clear RPC leaves it: the minted session closed, the successor live and working. */
function installClearedWorkerHost(): void {
  storeFailure = null
  historyFailure = null
  journalReads.length = 0
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
    // As the clear leaves the tab: it now shows the successor.
    getPersistedVisibleSessionTabIndex: () => ({ present: true, sessionIds: [SUCCESSOR] }),
    journalSnapshot: async (id: string) => {
      journalReads.push(id)
      if (records.get(id)?.lease.claimStatus !== 'live') {
        throw new Error(AGENT_SESSION_NOT_ATTACHED.code)
      }
      return { items: [message(`${id}-1`, 'idle')], submissions: [] }
    },
    close: async (id: string) => {
      closed.push(id)
      records.set(id, record(id, true))
    },
    history: async ({ sessionId }: { sessionId: string }) => {
      historyAsked.push(sessionId)
      if (historyFailure) {
        throw historyFailure
      }
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

/** A ready worker-start Dispatch whose worker is this structured worker; returns its id. */
function startWorkerDispatch(
  db: InstanceType<typeof OrchestrationDb>,
  worker: { handle: string; paneKey: string }
): string {
  const task = db.createTask({ runId: 'run_legacy_local', spec: 'work' })
  const { dispatch } = db.createStartingWorkerDispatch({
    taskId: task.id,
    startOptions: {},
    creator: { kind: 'system' },
    maxDepth: 9
  })
  db.prepareStartingWorkerAuthority({
    dispatchId: dispatch.id,
    handle: worker.handle,
    paneKey: worker.paneKey,
    processIncarnation: structuredWorkerProcessIncarnation(MINTED),
    worktreeId: 'wt_1',
    effects: [],
    setupState: 'not_configured',
    hostScope: JSON.stringify({ kind: 'local', hostId: 'local' }),
    terminalOwnership: 'created'
  })
  db.markWorkerDispatchReady(dispatch.id)
  return dispatch.id
}

/** The row the session host publishes into the agent-status store for a session. */
function structuredStatusRow(
  sessionId: string,
  state: 'working' | 'done'
): FleetAgentStatusEvidence {
  return {
    binding: { kind: 'unresolved', reason: 'pane_not_bound' },
    clock: { kind: 'observed', at: Date.now() },
    deliveredAt: Date.now(),
    activity: {
      paneKey: structuredAgentSessionPaneKey(structuredAgentSessionTabId(sessionId), sessionId),
      connectionId: null,
      state,
      agentType: 'claude',
      model: null,
      worktreeId: 'wt_1',
      restoredUnconfirmed: false,
      providerSessionOnly: false
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

  it('terminal read serves the successor', async () => {
    const identity = registerWorker()
    const read = await readStructuredWorkerTerminal({ handle: identity.handle, db: null })
    expect(historyAsked).toEqual([SUCCESSOR])
    expect(read?.status).toBe('running')
    expect(JSON.stringify(read)).toContain('POST-CLEAR')
  })

  it('worker-read serves the successor', async () => {
    const read = await readStructuredWorkerJournal({
      identity: registerWorker(),
      dispatchId: 'ctx_1',
      workerState: 'running',
      liveness: 'live',
      agent: 'claude'
    })
    expect(JSON.stringify(read)).toContain('POST-CLEAR')
    expect(JSON.stringify(read)).not.toContain('PRE-CLEAR')
  })

  it('the release archive freezes the successor', async () => {
    const archive = await captureStructuredWorkerArchive(registerWorker(), 'claude')
    expect(JSON.stringify(archive)).toContain('POST-CLEAR')
  })

  it("keeps the successor's journal when it cannot be read, as for any owned worker", async () => {
    historyFailure = new Error('journal busy')
    await expect(captureStructuredWorkerArchive(registerWorker(), 'claude')).rejects.toMatchObject({
      code: 'archive_failed'
    })
  })

  it("keeps the successor running for the worker's open Dispatch", () => {
    const db = new OrchestrationDb(':memory:')
    try {
      startWorkerDispatch(db, registerWorker())
      expect(structuredWorkerOwesWork(db, records.get(SUCCESSOR)!)).toBe(true)
    } finally {
      db.close()
    }
  })

  it("lists the worker with its successor's agent-status row, opening no journal", () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const dispatchId = startWorkerDispatch(db, registerWorker())
      const now = Date.now()
      const fleet = projectWorkerFleet({
        db,
        rows: db.listWorkerTerminalResources({ dispatchIds: [dispatchId], limit: 1 }),
        attentionFacts: db.getWorkerAttentionFactsForDispatches([dispatchId], now),
        statuses: [structuredStatusRow(SUCCESSOR, 'working')],
        limit: 1,
        now
      })
      expect(fleet.workers[0]).toMatchObject({
        liveness: { verdict: 'live', source: 'execution_host' },
        stage: { activity: 'working' }
      })
      expect(journalReads).toEqual([])
    } finally {
      db.close()
    }
  })

  it('reads a worker at rest with its Dispatch open as live in worker-list, worker-show and terminal read', async () => {
    // A rest (the idle sweep, a restart, the user's Stop) releases the lease with death evidence.
    records.set(SUCCESSOR, record(SUCCESSOR, true))
    const db = new OrchestrationDb(':memory:')
    try {
      const identity = registerWorker()
      const dispatchId = startWorkerDispatch(db, identity)
      const now = Date.now()
      const fleet = projectWorkerFleet({
        db,
        rows: db.listWorkerTerminalResources({ dispatchIds: [dispatchId], limit: 1 }),
        attentionFacts: db.getWorkerAttentionFactsForDispatches([dispatchId], now),
        statuses: [],
        limit: 1,
        now
      })
      expect(fleet.workers[0]?.liveness).toMatchObject({ verdict: 'live' })
      expect(fleet.workers[0]?.nextAction.kind).not.toBe('recover')
      expect(await inspectWorkerTerminal(new OrcaRuntimeService(), db, dispatchId)).toMatchObject({
        exact: true,
        status: 'live',
        addressable: true
      })
      expect((await readStructuredWorkerTerminal({ handle: identity.handle, db }))?.status).toBe(
        'running'
      )
      // Teardown and close keep the process verdict.
      expect(observeStructuredWorker(identity).status).toBe('exited')
    } finally {
      db.close()
    }
  })

  it('worker-show after a restart installs the session host first, so its verdicts agree', async () => {
    records.set(SUCCESSOR, record(SUCCESSOR, true))
    const db = new OrchestrationDb(':memory:')
    try {
      const dispatchId = startWorkerDispatch(db, registerWorker())
      const installed = hostRef.current
      // After a restart nothing has installed the host until something reads a session.
      hostRef.current = null
      const runtime = new OrcaRuntimeService()
      vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockImplementation(async () => {
        hostRef.current = installed
      })

      // worker-show reads the observation first, then the fleet projection.
      expect(await inspectWorkerTerminal(runtime, db, dispatchId)).toMatchObject({ status: 'live' })
      expect((await projectFleetWorker(runtime, db, dispatchId))?.liveness).toMatchObject({
        verdict: 'live'
      })
    } finally {
      db.close()
    }
  })

  it('worker-stop closes the successor that is doing the work', async () => {
    const stop = await stopStructuredWorker(registerWorker(), 'ctx_1')
    expect(closed).toEqual([SUCCESSOR])
    expect(stop.stopped).toBe(true)
  })

  it("agent status is the successor's", async () => {
    const identity = registerWorker()
    expect(await new OrcaRuntimeService().getAgentStatusForHandle(identity.handle)).toBe('idle')
  })
})

describe('terminal read by the Orca session ID an agent is shown', () => {
  beforeEach(() => {
    structuredWorkerIdentities.clear()
    historyAsked.length = 0
    installClearedWorkerHost()
  })

  it('reads a worker at orca_session_id:<its id>, served by the session running it', async () => {
    registerWorker()
    const read = await readStructuredWorkerTerminal({
      handle: `orca_session_id:${MINTED}`,
      db: null
    })
    expect(read?.handle).toBe(`orca_session_id:${MINTED}`)
    expect(historyAsked).toEqual([SUCCESSOR])
  })

  it('reads a chat, in the same shape a terminal read has', async () => {
    // No worker registered: MINTED is an ordinary chat the user cleared.
    const read = await readStructuredWorkerTerminal({
      handle: `orca_session_id:${MINTED}`,
      db: null
    })
    expect(historyAsked).toEqual([SUCCESSOR])
    expect(read).toMatchObject({ status: 'running', nextCursor: null, truncated: false })
    expect(read?.tail.join('\n')).toContain('POST-CLEAR')
  })

  it('reads a chat at rest as running, as worker-show and worker-list do', async () => {
    records.set(SUCCESSOR, record(SUCCESSOR, true))
    const read = await readStructuredWorkerTerminal({
      handle: `orca_session_id:${MINTED}`,
      db: null
    })
    expect(read?.status).toBe('running')
  })

  it('refuses a cursor, as for any structured session', async () => {
    await expect(
      readStructuredWorkerTerminal({ handle: `orca_session_id:${MINTED}`, db: null, cursor: 0 })
    ).rejects.toThrow(/without a cursor/)
  })

  it('leaves an address naming no session to the terminal lookup', async () => {
    expect(
      await readStructuredWorkerTerminal({
        handle: 'orca_session_id:9e1d2c3b-4a5f-4e6d-8c7b-6a5f4e3d2c1b',
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

    await expect(
      readStructuredWorkerJournal({
        identity,
        dispatchId: 'ctx_1',
        workerState: 'running',
        liveness: 'live',
        agent: 'claude'
      })
    ).rejects.toMatchObject({ code: 'session_caller_not_live' })
    await expect(stopStructuredWorker(identity, 'ctx_1')).rejects.toMatchObject({
      code: 'session_caller_not_live'
    })
    expect(historyAsked).toEqual([])
    expect(closed).toEqual([])
  })

  it('refuses a worker whose successor runs on another host with the typed host-boundary refusal', async () => {
    const identity = registerWorker()
    const successor = records.get(SUCCESSOR)!
    records.set(SUCCESSOR, {
      ...successor,
      location: { ...successor.location, executionHostId: 'ssh:box' }
    })

    await expect(
      readStructuredWorkerTerminal({ handle: identity.handle, db: null })
    ).rejects.toMatchObject({ code: 'session_caller_host_boundary' })
    // Mail maps the same verdict to "not deliverable here".
    expect(structuredWorkerMailSessionId(MINTED)).toBeNull()
  })

  it('refuses a chat on another host with the typed host-boundary refusal', async () => {
    const successor = records.get(SUCCESSOR)!
    records.set(SUCCESSOR, {
      ...successor,
      location: { ...successor.location, executionHostId: 'ssh:box' }
    })

    await expect(
      readStructuredWorkerTerminal({ handle: `orca_session_id:${MINTED}`, db: null })
    ).rejects.toMatchObject({ code: 'session_caller_host_boundary' })
  })
})
