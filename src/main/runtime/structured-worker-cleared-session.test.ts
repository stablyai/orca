/**
 * A structured worker the user `/clear`ed carries on in a successor session. Every worker-level
 * reader and actor must reach the session running it now, read the whole conversation, and say
 * `unverifiable` — never `exited` — when it cannot find that session.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
const { observeStructuredSession, observeStructuredWorker, resolveStructuredWorkerAuthority } =
  await import('./structured-worker-authority')
const { structuredSessionMailTarget, structuredSessionOwnedMailboxes } =
  await import('./orchestration/structured-session-mail-target')
const { structuredSessionMailReach } =
  await import('./orchestration/structured-session-mail-address')
const { stopStructuredWorker, readStructuredWorkerJournal, captureStructuredWorkerArchive } =
  await import('./rpc/methods/orchestration-structured-worker-lifecycle')
const { releaseStructuredWorkerSession } =
  await import('./rpc/methods/orchestration-structured-worker-session')
const { inspectWorkerTerminal } =
  await import('./rpc/methods/orchestration/worker/worker-observation')
const { listAddressableStructuredWorkers } =
  await import('./orchestration/structured-worker-group-addressing')
const { readStructuredLineageJournalPage, STRUCTURED_JOURNAL_PAGE_LIMIT } =
  await import('./orchestration/structured-worker-journal-page')
const { structuredSessionChildIdentityEnv } =
  await import('./structured-session-child-identity-env')
const { foundAgentSessionRecord } = await import('./agent-session-record-founding')
const { applyAgentSessionRestartAdjudication } =
  await import('./agent-session-restart-lease-transitions')
const { openTestAgentSessionRecordStore } =
  await import('./agent-session-record-store-test-harness')
const { OrcaRuntimeService } = await import('./orca-runtime')
const { OrchestrationDb } = await import('./orchestration/db')
const { ORCHESTRATION_METHODS } = await import('./rpc/methods/orchestration')
const { eraseRpcMethods } = await import('./rpc/core')
const { structuredWorkerOwesWork } = await import('./structured-worker-custody')
const { AGENT_SESSION_NOT_ATTACHED } =
  await import('../native-chat/agent-session-wire/structured-agent-session-mutation-admission')
const {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} = await import('./structured-worker-identity')

type Db = InstanceType<typeof OrchestrationDb>
type Runtime = InstanceType<typeof OrcaRuntimeService>

const MINTED = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const SUCCESSOR = 'clear-a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const SECOND = 'clear-ffeeddccbbaa99887766554433221100ffeeddcc'
const LOCAL_SCOPE = { kind: 'local', hostId: 'local' } as const

/** Opens the protected mail resolver and the orchestration database a real runtime holds. */
class RuntimeProbe extends OrcaRuntimeService {
  withDb(db: Db | null): this {
    this._orchestrationDb = db
    return this
  }

  mailTarget(mailboxHandle: string): unknown {
    return this.resolveStructuredMailboxTarget(mailboxHandle)
  }
}

function message(id: string, text: string): AgentJournalRenderItem {
  return {
    itemId: id,
    revision: 1,
    observedAt: 1,
    sequence: 1,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
  }
}

function located(record: AgentSessionRecord): AgentSessionRecord {
  return { ...record, location: { ...record.location, workspaceId: 'wt_1' } }
}

/** A session whose agent runs now. */
function liveRecord(sessionId: string): AgentSessionRecord {
  return located(agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId })))
}

/** What the clear leaves on the source: its agent stopped with evidence, pointing at `next`. */
function clearedRecord(sessionId: string, next: string): AgentSessionRecord {
  const base = liveRecord(sessionId)
  return {
    ...base,
    lease: {
      ...base.lease,
      claimStatus: 'released',
      ownerProcess: null,
      deathEvidence: { kind: 'exit-observed', detail: 'user-close', observedAt: 2, ownerFence: 7 }
    },
    conversationCommand: {
      command: 'clear',
      runtimeFence: 8,
      operationId: `op-clear-${sessionId}`,
      callerKey: 'renderer',
      phase: 'committed',
      state: 'completed',
      replacementSessionId: next
    }
  }
}

/** What the clear founds: a conversation no agent has run yet, at rest. */
function foundedRecord(sessionId: string): AgentSessionRecord {
  return foundAgentSessionRecord(
    { ...liveRecord(sessionId), sessionId },
    { claimKeyId: 'key-1', now: 5 }
  )
}

const records = new Map<string, AgentSessionRecord>()
/** Sessions with an attached provider child. */
const children = new Set<string>()
/** Conversations open in the host, which is what the real `hasSession` answers; a child implies one. */
const open = new Set<string>()
let visibleTabs: string[] = []
/** False: the persisted tab index could not be read, which proves nothing about a chat. */
let tabIndexPresent = true
const journals = new Map<string, AgentJournalRenderItem[]>()
const unreadable = new Set<string>()
/** Set to commit a /clear of the minted session while its close waits behind it. */
let clearDuringClose = false
/** A session whose tab hide fails. */
let failHideOf: string | null = null
const closed: string[] = []
const historyAsked: string[] = []
const journalAsked: string[] = []

/** The clear of the minted session as the host commits it: stop with evidence, found, move tab. */
function commitClear(): void {
  children.delete(MINTED)
  records.set(MINTED, clearedRecord(MINTED, SUCCESSOR))
  records.set(SUCCESSOR, foundedRecord(SUCCESSOR))
  // A source with no tab (the stop already hid it) still shows its successor.
  visibleTabs = [...visibleTabs.filter((id) => id !== MINTED), SUCCESSOR]
}

/** Installs exactly these sessions and tabs; those in `running` have an attached child. */
function installSessions(
  sessions: readonly AgentSessionRecord[],
  tabs: string[],
  running: readonly string[] = []
): void {
  records.clear()
  children.clear()
  sessions.forEach((session) => records.set(session.sessionId, session))
  running.forEach((sessionId) => children.add(sessionId))
  visibleTabs = tabs
  installHost()
}

/** As `/clear` leaves a worker: its old session stopped and pointing on, its tab renamed. */
function installClearedWorker(successor: 'live' | 'at-rest' = 'live'): void {
  const live = successor === 'live'
  installSessions(
    [clearedRecord(MINTED, SUCCESSOR), live ? liveRecord(SUCCESSOR) : foundedRecord(SUCCESSOR)],
    [SUCCESSOR],
    live ? [SUCCESSOR] : []
  )
}

/** A worker running in the session it was minted under, before any clear. */
function installUnclearedWorker(): void {
  installSessions([liveRecord(MINTED)], [MINTED], [MINTED])
}

function installHost(): void {
  hostRef.current = {
    deps: {
      store: {
        getRecord: (id: string) => records.get(id) ?? null,
        listRecords: () => [...records.values()],
        getVisibleSessionTabIndex: () => ({ present: tabIndexPresent, sessionIds: visibleTabs }),
        getSessionTabId: () => null
      },
      logger: { warn: () => {} }
    },
    hasSession: (id: string) => open.has(id) || children.has(id),
    getPersistedVisibleSessionTabIndex: () => ({
      present: tabIndexPresent,
      sessionIds: visibleTabs
    }),
    journalSnapshot: async (id: string) => {
      journalAsked.push(id)
      if (!records.has(id)) {
        throw new Error(AGENT_SESSION_NOT_ATTACHED.code)
      }
      open.add(id)
      return { items: [message(`${id}-1`, 'idle')], submissions: [] }
    },
    setSessionTabVisibility: async (id: string, visible: boolean) => {
      if (id === failHideOf) {
        throw new Error('the durable tab index is wedged')
      }
      visibleTabs = visible ? [...visibleTabs, id] : visibleTabs.filter((tab) => tab !== id)
    },
    // As the real close: a child is stopped with exit evidence (none, nothing is written), and the
    // conversation is dropped.
    close: async (id: string) => {
      closed.push(id)
      open.delete(id)
      if (clearDuringClose && id === MINTED) {
        // The clear held the session's lock first: it commits, then this close runs.
        clearDuringClose = false
        commitClear()
        return
      }
      const prior = records.get(id)
      if (prior && children.has(id)) {
        children.delete(id)
        records.set(id, {
          ...prior,
          lease: {
            ...prior.lease,
            claimStatus: 'released',
            ownerProcess: null,
            deathEvidence: { kind: 'exit-observed', detail: 'evict', observedAt: 3, ownerFence: 7 }
          }
        })
      }
    },
    history: async ({ sessionId, limit }: { sessionId: string; limit: number }) => {
      historyAsked.push(sessionId)
      if (unreadable.has(sessionId)) {
        throw new Error(AGENT_SESSION_NOT_ATTACHED.code)
      }
      // As the real history: reading opens a closed conversation, and it stays open.
      open.add(sessionId)
      const items = journals.get(sessionId) ?? [
        message(
          `${sessionId}-1`,
          sessionId === MINTED ? 'PRE-CLEAR (dispatch work)' : 'POST-CLEAR (live work)'
        )
      ]
      return { page: { items: items.slice(-limit), hasOlder: items.length > limit } }
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
    hostScope: LOCAL_SCOPE
  })
}

/** A ready worker Dispatch owning the worker's terminal resource, as worker-start leaves it. */
function startWorkerDispatch(
  db: Db,
  identity: ReturnType<typeof registerWorker>,
  runtimeEpoch?: string
): string {
  const runId = db.createRun({
    objective: 'cleared worker',
    coordinatorHandle: null,
    coordinatorPaneKey: null
  }).id
  const task = db.createTask({ runId, spec: 'work' })
  const { dispatch } = db.createStartingWorkerDispatch({
    taskId: task.id,
    startOptions: {},
    creator: { kind: 'system' },
    maxDepth: 9,
    ...(runtimeEpoch ? { runtimeEpoch } : {})
  })
  db.prepareStartingWorkerAuthority({
    dispatchId: dispatch.id,
    handle: identity.handle,
    paneKey: identity.paneKey,
    processIncarnation: identity.processIncarnation,
    worktreeId: 'wt_1',
    effects: [],
    setupState: 'not_configured',
    hostScope: JSON.stringify(LOCAL_SCOPE),
    terminalOwnership: 'created'
  })
  db.markWorkerDispatchReady(dispatch.id)
  return dispatch.id
}

/** A real runtime over `db` with the orchestration RPCs, as a coordinator calls them. */
function rpcRuntime(db: Db): {
  runtime: Runtime
  call: (name: string, params: Record<string, unknown>) => Promise<unknown>
} {
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue(undefined)
  return {
    runtime,
    call: async (name, params) => {
      const method = eraseRpcMethods(ORCHESTRATION_METHODS).find(
        (candidate) => candidate.name === name
      )
      if (!method?.params) {
        throw new Error(`Method not found: ${name}`)
      }
      return method.handler(method.params.parse(params), { runtime })
    }
  }
}

/** The coordinator releases a worker whose Dispatch succeeded. */
function releaseSucceeded(dispatchId: string): Promise<unknown> {
  db.db
    .prepare("UPDATE worker_dispatches SET state = 'succeeded' WHERE dispatch_id = ?")
    .run(dispatchId)
  return rpcRuntime(db).call('orchestration.workerRelease', { dispatch: dispatchId })
}

function readJournal(identity: ReturnType<typeof registerWorker>, cursor?: string) {
  return readStructuredWorkerJournal({
    identity,
    dispatchId: 'ctx_1',
    workerState: 'ready',
    liveness: 'live',
    agent: 'claude',
    ...(cursor === undefined ? {} : { cursor })
  })
}

function texts(messages: readonly { blocks: readonly unknown[] }[] | undefined): string {
  return JSON.stringify(messages ?? [])
}

let db: Db

beforeEach(() => {
  structuredWorkerIdentities.clear()
  closed.length = 0
  historyAsked.length = 0
  journalAsked.length = 0
  journals.clear()
  unreadable.clear()
  open.clear()
  tabIndexPresent = true
  clearDuringClose = false
  failHideOf = null
  db = new OrchestrationDb(':memory:')
})

afterEach(() => {
  db.close()
  hostRef.current = null
  vi.restoreAllMocks()
})

describe.each(['live', 'at-rest'] as const)(
  'a /clear-ed structured worker whose successor is %s',
  (successor) => {
    beforeEach(() => installClearedWorker(successor))

    it('keeps its authority, judged on and naming the successor', () => {
      const identity = registerWorker()
      expect(resolveStructuredWorkerAuthority(identity.handle, null)?.running.sessionId).toBe(
        SUCCESSOR
      )
    })

    it('is observed on the successor, never as the exited minted session', () => {
      const identity = registerWorker()
      const expected = successor === 'live' ? 'live' : 'unverifiable'
      expect(observeStructuredWorker(identity).status).toBe(expected)
      // The settlement probe holds only the incarnation, and no registry entry.
      structuredWorkerIdentities.clear()
      return expect(
        new OrcaRuntimeService().inspectTerminalProcessIncarnationLiveness(
          structuredWorkerProcessIncarnation(MINTED),
          JSON.stringify(LOCAL_SCOPE)
        )
      ).resolves.toBe(expected)
    })

    it("serves terminal read from the whole conversation, the successor's last", async () => {
      const identity = registerWorker()
      const read = await readStructuredWorkerTerminal({ handle: identity.handle, db: null })
      expect(historyAsked).toEqual([SUCCESSOR, MINTED])
      const lines = JSON.stringify(read)
      expect(lines.indexOf('PRE-CLEAR')).toBeGreaterThan(-1)
      expect(lines.indexOf('POST-CLEAR')).toBeGreaterThan(lines.indexOf('PRE-CLEAR'))
    })

    it('serves worker-read from the whole conversation, oldest session first', async () => {
      const read = await readJournal(registerWorker())
      const transcript = texts(read.transcript?.messages)
      expect(transcript.indexOf('PRE-CLEAR')).toBeGreaterThan(-1)
      expect(transcript.indexOf('POST-CLEAR')).toBeGreaterThan(transcript.indexOf('PRE-CLEAR'))
      expect(read.warnings.join(' ')).not.toMatch(/clear/i)
    })

    it('freezes the whole conversation into the release archive', async () => {
      const archive = await captureStructuredWorkerArchive(registerWorker(), 'claude')
      const frozen = texts(archive.messages)
      expect(frozen.indexOf('PRE-CLEAR')).toBeGreaterThan(-1)
      expect(frozen.indexOf('POST-CLEAR')).toBeGreaterThan(frozen.indexOf('PRE-CLEAR'))
    })

    it("retains the worker when the successor's journal cannot be read", async () => {
      unreadable.add(SUCCESSOR)
      await expect(
        captureStructuredWorkerArchive(registerWorker(), 'claude')
      ).rejects.toMatchObject({ code: 'archive_failed' })
      expect(historyAsked).toEqual([SUCCESSOR])
    })

    it('shows the worker through the successor in worker-show', async () => {
      const identity = registerWorker()
      const dispatchId = startWorkerDispatch(db, identity)
      const shown = await inspectWorkerTerminal(new OrcaRuntimeService(), db, dispatchId)
      expect(shown).toMatchObject({
        exact: true,
        status: successor === 'live' ? 'live' : 'unverifiable',
        addressable: true
      })
    })

    it('stops the worker by closing the successor, and can then release it', async () => {
      const identity = registerWorker()
      const stop = await stopStructuredWorker(identity, 'ctx_1')
      expect(closed).toEqual([SUCCESSOR])
      expect(stop.stopped).toBe(true)
      // Release settles a stopped worker only on the probe's `exited`: a successor no agent ever
      // ran gets no death evidence from its close, and must not read `unverifiable` forever.
      structuredWorkerIdentities.clear()
      await expect(
        new OrcaRuntimeService().inspectTerminalProcessIncarnationLiveness(
          identity.processIncarnation,
          JSON.stringify(LOCAL_SCOPE)
        )
      ).resolves.toBe('exited')
    })

    it("reports the successor's status to @idle", async () => {
      const identity = registerWorker()
      await expect(new OrcaRuntimeService().getAgentStatusForHandle(identity.handle)).resolves.toBe(
        'idle'
      )
      expect(journalAsked).toEqual([SUCCESSOR])
    })

    it('stays a group-address recipient', () => {
      const identity = registerWorker()
      startWorkerDispatch(db, identity)
      expect(listAddressableStructuredWorkers(db)).toEqual([
        { handle: identity.handle, worktreeId: 'wt_1', agentIdentity: 'claude' }
      ])
    })

    it('routes direct and Dispatch mail to the successor', () => {
      const identity = registerWorker()
      const dispatchId = startWorkerDispatch(db, identity)
      const runtime = new RuntimeProbe().withDb(db)
      expect(runtime.mailTarget(identity.handle)).toEqual({ sessionId: SUCCESSOR, dispatchId })
      expect(runtime.mailTarget(`dispatch:${dispatchId}`)).toEqual({
        sessionId: SUCCESSOR,
        dispatchId
      })
    })

    it("re-derives the worker's Dispatch mailbox on the successor's idle edge", () => {
      const identity = registerWorker()
      const dispatchId = startWorkerDispatch(db, identity)
      expect(structuredSessionOwnedMailboxes(SUCCESSOR, db)).toContain(`dispatch:${dispatchId}`)
    })

    it("gives the successor's child the worker's handle", () => {
      const identity = registerWorker()
      expect(structuredSessionChildIdentityEnv(SUCCESSOR, {}).ORCA_TERMINAL_HANDLE).toBe(
        identity.handle
      )
    })

    it("records the user's takeover when they type into the successor", () => {
      const identity = registerWorker()
      expect(new RuntimeProbe().withDb(db).getStructuredWorkerPaneKeyForSession(SUCCESSOR)).toBe(
        identity.paneKey
      )
    })

    it("keeps the successor running for the worker's open Dispatch", () => {
      startWorkerDispatch(db, registerWorker())
      const successorRecord = records.get(SUCCESSOR)
      expect(successorRecord && structuredWorkerOwesWork(db, successorRecord)).toBe(true)
    })

    it('finds the worker from its durable row after a restart', () => {
      const identity = registerWorker()
      startWorkerDispatch(db, identity)
      structuredWorkerIdentities.clear()
      expect(new RuntimeProbe().withDb(db).getStructuredWorkerPaneKeyForSession(SUCCESSOR)).toBe(
        identity.paneKey
      )
      structuredWorkerIdentities.clear()
      expect(resolveStructuredWorkerAuthority(identity.handle, db)?.running.sessionId).toBe(
        SUCCESSOR
      )
    })
  }
)

describe("a /clear typed into the worker's chat", () => {
  it('is a user takeover: the report names the pre-clear session and reaches the worker', async () => {
    installClearedWorker('at-rest')
    const identity = registerWorker()
    const dispatchId = startWorkerDispatch(db, identity)
    const { call } = rpcRuntime(db)
    // The composer reports every accepted send, a handled /clear included, by the session it sent to.
    await expect(
      call('orchestration.workerTerminalUserInput', { sessionId: MINTED })
    ).resolves.toEqual({ changed: 1 })
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      ownership_state: 'user_owned'
    })
  })

  it('and so is typing after the clear, reported by the successor session', async () => {
    installClearedWorker('live')
    const identity = registerWorker()
    const dispatchId = startWorkerDispatch(db, identity)
    const { call } = rpcRuntime(db)
    await expect(
      call('orchestration.workerTerminalUserInput', { sessionId: SUCCESSOR })
    ).resolves.toEqual({ changed: 1 })
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      ownership_state: 'user_owned'
    })
  })
})

describe('a successor no agent ever ran', () => {
  beforeEach(() => installClearedWorker('at-rest'))

  it('reads unverifiable while its chat is listed, and exited once the chat is gone', () => {
    const identity = registerWorker()
    expect(observeStructuredWorker(identity).status).toBe('unverifiable')
    visibleTabs = []
    expect(observeStructuredWorker(identity).status).toBe('exited')
  })

  it.each([false, true])(
    'lets a stopped worker be released (output read in between, reopening the chat: %s)',
    async (readBetween) => {
      const identity = registerWorker()
      const { runtime, call } = rpcRuntime(db)
      const dispatchId = startWorkerDispatch(db, identity, runtime.getRuntimeId())
      await expect(
        call('orchestration.workerStop', { dispatch: dispatchId })
      ).resolves.toMatchObject({ state: 'stopped' })
      if (readBetween) {
        await readJournal(identity)
        expect(open.has(SUCCESSOR)).toBe(true)
      }
      structuredWorkerIdentities.clear()
      await expect(
        call('orchestration.workerRelease', { dispatch: dispatchId })
      ).resolves.toMatchObject({ state: 'released' })
    }
  )

  it('stays unverifiable when the tab index cannot be read', () => {
    visibleTabs = []
    tabIndexPresent = false
    expect(observeStructuredSession(SUCCESSOR).status).toBe('unverifiable')
  })

  it('stays unverifiable when restored from a backup that may have lost a reservation', () => {
    visibleTabs = []
    const founded = foundedRecord(SUCCESSOR)
    records.set(SUCCESSOR, { ...founded, lease: { ...founded.lease, minimumNextFence: 3 } })
    expect(observeStructuredSession(SUCCESSOR).status).toBe('unverifiable')
  })
})

describe('a released session whose start was attempted stays unverifiable without proof', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-cleared-successor-'))
    installClearedWorker('at-rest')
    visibleTabs = []
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  async function reserveSuccessor(operationId: string) {
    const store = await openTestAgentSessionRecordStore(directory)
    const reserved = await store.reserveOwner({
      sessionId: SUCCESSOR,
      location: liveRecord(SUCCESSOR).location,
      provider: 'claude',
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude' },
      expectedFence: null,
      spawnToken: 'spawn-a',
      claimKeyId: 'key-1',
      handoffOperationId: operationId,
      probe: { outcome: 'indeterminate', reason: 'no answer' },
      operation: { callerKey: 'client-1', operationId, fingerprint: 'fp-1' },
      now: NOW
    })
    return { store, reserved: reserved.record }
  }

  const NOW = 1_800_000_000_000
  const OPERATION_ID = `${NOW}-${'1'.padStart(32, '0')}`

  it('after a restart released a reservation whose child was never ruled out', async () => {
    const { reserved } = await reserveSuccessor(OPERATION_ID)
    const recovered = applyAgentSessionRestartAdjudication({
      record: reserved,
      probe: { outcome: 'indeterminate', reason: 'no answer' },
      now: NOW + 1
    })
    expect(recovered.lease).toMatchObject({ claimStatus: 'released', deathEvidence: null })
    records.set(SUCCESSOR, recovered)
    expect(observeStructuredSession(SUCCESSOR).status).toBe('unverifiable')
  })

  it('after a failed first start whose exit was not proven', async () => {
    const { store, reserved } = await reserveSuccessor(OPERATION_ID)
    const settled = await store.settleFailedAcquisition({
      sessionId: SUCCESSOR,
      fence: reserved.lease.runtimeFence,
      spawnToken: 'spawn-a',
      callerKey: 'client-1',
      operationId: OPERATION_ID,
      outcome: { status: 'failed', code: 'agent_session_operation_invalid', message: 'failed' },
      exitProof: 'unproven',
      now: NOW + 1
    })
    expect(settled.lease).toMatchObject({ claimStatus: 'released', deathEvidence: null })
    records.set(SUCCESSOR, settled)
    expect(observeStructuredSession(SUCCESSOR).status).toBe('unverifiable')
  })
})

describe('stopping a worker while a /clear commits', () => {
  beforeEach(() => {
    installUnclearedWorker()
    clearDuringClose = true
  })

  it('closes the successor the clear handed the worker to', async () => {
    const stop = await stopStructuredWorker(registerWorker(), 'ctx_1')
    expect(closed).toEqual([MINTED, SUCCESSOR])
    expect(stop.stopped).toBe(true)
  })

  it('keeps an earlier close on the receipt when a later one fails', async () => {
    failHideOf = SUCCESSOR
    const stop = await stopStructuredWorker(registerWorker(), 'ctx_1')
    expect(closed).toEqual([MINTED])
    expect(stop).toMatchObject({ stopped: false, closeAttempted: true })
  })

  it('stops through worker-stop when the old session already reads exited mid-clear', async () => {
    // Paused between the clear's stop of the old agent and its commit: exited, no pointer yet.
    children.delete(MINTED)
    const base = clearedRecord(MINTED, SUCCESSOR)
    const { conversationCommand: _uncommitted, ...stoppedForClear } = base
    records.set(MINTED, stoppedForClear)
    const identity = registerWorker()
    const { runtime, call } = rpcRuntime(db)
    const dispatchId = startWorkerDispatch(db, identity, runtime.getRuntimeId())
    await expect(call('orchestration.workerStop', { dispatch: dispatchId })).resolves.toMatchObject(
      { state: 'stopped', processAction: 'closed_agent_terminal' }
    )
    expect(closed).toEqual([MINTED, SUCCESSOR])
  })
})

describe('worker-stop on a structured worker that reads exited without any /clear', () => {
  it("closes and hides the crashed agent's still-listed chat, and settles stopped", async () => {
    const { conversationCommand: _none, ...crashed } = clearedRecord(MINTED, SUCCESSOR)
    installSessions([crashed], [MINTED])
    const identity = registerWorker()
    const { runtime, call } = rpcRuntime(db)
    const dispatchId = startWorkerDispatch(db, identity, runtime.getRuntimeId())
    await expect(call('orchestration.workerStop', { dispatch: dispatchId })).resolves.toMatchObject(
      { state: 'stopped', processAction: 'closed_agent_terminal' }
    )
    expect(closed).toEqual([MINTED])
    expect(visibleTabs).not.toContain(MINTED)
  })
})

describe.each([
  { clears: 1, warning: /latest session .* could not be preserved; earlier sessions were/ },
  { clears: 2, warning: /latest 2 sessions .* could not be preserved; earlier sessions were/ }
])('a retired lineage of $clears clear(s) whose later sessions cannot be read', (lineage) => {
  beforeEach(() => {
    // The user closed the cleared chat, and every journal after the first is gone.
    const later = lineage.clears === 1 ? [SUCCESSOR] : [SUCCESSOR, SECOND]
    const newest = later.at(-1) ?? SUCCESSOR
    const chain = lineage.clears === 1 ? [] : [clearedRecord(SUCCESSOR, SECOND)]
    installSessions([clearedRecord(MINTED, SUCCESSOR), ...chain, foundedRecord(newest)], [])
    later.forEach((sessionId) => unreadable.add(sessionId))
  })

  it('archives the readable earliest session and says how many later ones were lost', async () => {
    const archive = await captureStructuredWorkerArchive(registerWorker(), 'claude')
    expect(texts(archive.messages)).toContain('PRE-CLEAR')
    expect(archive.warnings.join(' ')).toMatch(lineage.warning)
  })

  it('commits that archive when the worker is released', async () => {
    const dispatchId = startWorkerDispatch(db, registerWorker())
    await expect(releaseSucceeded(dispatchId)).resolves.toMatchObject({ state: 'released' })
    expect(db.getWorkerTerminalArchive(dispatchId)?.content).toContain('PRE-CLEAR')
  })
})

describe('the worker-read cursor across a /clear', () => {
  it('stays valid: what the caller already read did not change, the successor follows it', async () => {
    installUnclearedWorker()
    journals.set(MINTED, [message('i1', 'PRE-CLEAR (dispatch work)')])
    const identity = registerWorker()
    const before = await readJournal(identity)
    expect(before.transcript?.returnedMessageCount).toBe(1)
    commitClear()
    journals.set(SUCCESSOR, [message('i1', 'POST-CLEAR (live work)')])
    const after = await readJournal(identity, before.cursor ?? undefined)
    expect(texts(after.transcript?.messages)).toContain('POST-CLEAR')
    expect(texts(after.transcript?.messages)).not.toContain('PRE-CLEAR')
  })
})

describe('the lineage journal page', () => {
  beforeEach(() => installClearedWorker('live'))

  it('fills one page limit newest first and says older history was left out', async () => {
    const many = (sessionId: string) =>
      Array.from({ length: 150 }, (_, index) => message(`${sessionId}-${index}`, `${index}`))
    journals.set(MINTED, many(MINTED))
    journals.set(SUCCESSOR, many(SUCCESSOR))
    const page = await readStructuredLineageJournalPage([MINTED, SUCCESSOR])
    expect(page?.items).toHaveLength(STRUCTURED_JOURNAL_PAGE_LIMIT)
    expect(page?.items[0]?.itemId).toBe(`${MINTED}-100`)
    expect(page?.items.at(-1)?.itemId).toBe(`${SUCCESSOR}-149`)
    expect(page?.sessionIds.filter((id) => id === MINTED)).toHaveLength(50)
    expect(page?.hasOlder).toBe(true)
  })

  it('ends at an earlier session it cannot read, and says older history was left out', async () => {
    unreadable.add(MINTED)
    const read = await readJournal(registerWorker())
    expect(texts(read.transcript?.messages)).toContain('POST-CLEAR')
    expect(read.warnings).toContain('Older journal items were omitted from this page.')
  })
})

describe('a worker cleared twice', () => {
  beforeEach(() => {
    const chain = [clearedRecord(MINTED, SUCCESSOR), clearedRecord(SUCCESSOR, SECOND)]
    installSessions([...chain, liveRecord(SECOND)], [SECOND], [SECOND])
  })

  it('is read across all three sessions and stopped through the newest', async () => {
    const identity = registerWorker()
    expect(resolveStructuredWorkerAuthority(identity.handle, null)?.running.sessionId).toBe(SECOND)
    await readJournal(identity)
    expect(historyAsked).toEqual([SECOND, SUCCESSOR, MINTED])
    await stopStructuredWorker(identity, 'ctx_1')
    expect(closed).toEqual([SECOND])
  })

  it('forgets parked mail on every session of the lineage at settlement, binding or not', () => {
    const forgetStructuredSessionMail = vi.fn()
    // No binding: what a restarted runtime holds when the worker settles.
    releaseStructuredWorkerSession('ctx_after_restart', { forgetStructuredSessionMail }, MINTED)
    expect(forgetStructuredSessionMail.mock.calls.map(([sessionId]) => sessionId)).toEqual([
      MINTED,
      SUCCESSOR,
      SECOND
    ])
  })
})

describe('abandoning a side task of a structured worker', () => {
  it("leaves the still-running worker's parked mail alone", async () => {
    installClearedWorker('live')
    const identity = registerWorker()
    const runId = db.createRun({
      objective: 'side',
      coordinatorHandle: null,
      coordinatorPaneKey: null
    }).id
    const task = db.createTask({ runId, spec: 'side task' })
    const sideTask = db.createDispatchContext({
      taskId: task.id,
      assigneeHandle: identity.handle,
      assigneePaneKey: identity.paneKey,
      processIncarnation: identity.processIncarnation,
      creator: { kind: 'system' },
      maxDepth: 9
    })
    const { runtime, call } = rpcRuntime(db)
    const forget = vi.spyOn(runtime, 'forgetStructuredSessionMail')
    await expect(
      call('orchestration.workerAbandon', { dispatch: sideTask.id })
    ).resolves.toMatchObject({ alreadySettled: false })
    expect(forget).not.toHaveBeenCalled()
  })
})

describe('a running session that cannot be verified is refused, never declared exited', () => {
  async function expectRefused(identity: ReturnType<typeof registerWorker>, code: string) {
    await expect(readJournal(identity)).rejects.toMatchObject({ code })
    await expect(captureStructuredWorkerArchive(identity, 'claude')).rejects.toMatchObject({
      code
    })
    await expect(
      readStructuredWorkerTerminal({ handle: identity.handle, db: null })
    ).rejects.toMatchObject({ code })
    const stop = await stopStructuredWorker(identity, 'ctx_1')
    expect(stop).toMatchObject({ stopped: false, closeAttempted: false })
    expect(stop.reason).toContain('No effects were applied')
    expect(historyAsked).toEqual([])
    expect(closed).toEqual([])
  }

  function installMissingSuccessor(): void {
    installSessions([clearedRecord(MINTED, SUCCESSOR)], [SUCCESSOR])
  }

  it('when the clear names a successor with no record', async () => {
    installMissingSuccessor()
    const identity = registerWorker()
    expect(observeStructuredWorker(identity).status).toBe('unverifiable')
    await expect(
      new OrcaRuntimeService().inspectTerminalProcessIncarnationLiveness(
        identity.processIncarnation,
        JSON.stringify(LOCAL_SCOPE)
      )
    ).resolves.toBe('unverifiable')
    await expectRefused(identity, 'session_caller_not_live')
  })

  it('and a release of it ends unknown, not requested forever', async () => {
    installMissingSuccessor()
    const dispatchId = startWorkerDispatch(db, registerWorker())
    await expect(releaseSucceeded(dispatchId)).resolves.toMatchObject({
      state: 'release_unknown',
      processAction: 'none'
    })
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('unknown')
  })

  it('when the lineage loops back on itself', async () => {
    installSessions(
      [clearedRecord(MINTED, SUCCESSOR), clearedRecord(SUCCESSOR, MINTED)],
      [SUCCESSOR]
    )
    const identity = registerWorker()
    expect(observeStructuredWorker(identity).status).toBe('unverifiable')
    expect(structuredSessionMailTarget(MINTED, null)).toBeNull()
    const mintedRecord = records.get(MINTED)
    const store = { getRecord: (id: string) => records.get(id) ?? null, listRecords: () => [] }
    expect(mintedRecord && structuredSessionMailReach(store, mintedRecord, null)).toMatchObject({
      kind: 'unverifiable'
    })
    await expectRefused(identity, 'session_caller_not_live')
  })

  it('when the structured host is not installed', async () => {
    hostRef.current = null
    const identity = registerWorker()
    await expect(readJournal(identity)).rejects.toMatchObject({ code: 'session_caller_not_live' })
    await expect(captureStructuredWorkerArchive(identity, 'claude')).rejects.toMatchObject({
      code: 'session_caller_not_live'
    })
  })

  it('with the host-boundary refusal when the successor runs on another host', async () => {
    installClearedWorker()
    const successor = records.get(SUCCESSOR)
    if (successor) {
      records.set(SUCCESSOR, {
        ...successor,
        location: { ...successor.location, executionHostId: 'ssh:box' }
      })
    }
    const identity = registerWorker()
    expect(observeStructuredWorker(identity).status).toBe('unverifiable')
    await expectRefused(identity, 'session_caller_host_boundary')
  })
})
