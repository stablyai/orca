/**
 * Clearing a worker changes provider context while its conversation and orchestration identity
 * stay the same. Missing execution-host evidence remains unverifiable.
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
const { readStructuredJournalPage, STRUCTURED_JOURNAL_PAGE_LIMIT } =
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
const { LOCAL_SCOPE, RuntimeProbe, startWorkerDispatch, rpcRuntime } =
  await import('./structured-worker-orchestration-test-fixture')
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

const MINTED = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const UNSTARTED = 'clear-a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

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

/** Clear releases provider ownership while retaining the conversation. */
function clearedRecord(sessionId: string, operationId = 'clear-1'): AgentSessionRecord {
  const base = records.get(sessionId) ?? liveRecord(sessionId)
  return {
    ...base,
    providerHandleChain: [],
    lease: {
      ...base.lease,
      provenHandleLinkId: null,
      claimStatus: 'released',
      ownerProcess: null,
      deathEvidence: {
        kind: 'exit-observed',
        detail: 'context-clear',
        observedAt: 2,
        ownerFence: 7
      }
    },
    providerContextBoundary: {
      operationId,
      afterFence: base.lease.runtimeFence,
      clearedAt: 2
    },
    conversationCommand: {
      command: 'clear',
      runtimeFence: base.lease.runtimeFence,
      operationId,
      callerKey: 'renderer',
      phase: 'committed',
      state: 'completed'
    }
  }
}

/** A separate never-started conversation for lifecycle-proof controls. */
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

/** Clear retains the journal, tab and conversation identity. */
function commitClear(): void {
  children.delete(MINTED)
  const rows = journals.get(MINTED) ?? [message('i-pre', 'PRE-CLEAR (dispatch work)')]
  const operationId = `clear-${rows.length}`
  records.set(MINTED, clearedRecord(MINTED, operationId))
  rows.push({
    itemId: operationId,
    revision: 1,
    observedAt: 2,
    sequence: rows.length + 1,
    body: { kind: 'status', text: 'Context cleared', presentation: 'context-cleared' }
  })
  journals.set(MINTED, rows)
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

/** After clear, the next provider may be running or the conversation may remain at rest. */
function installClearedWorker(context: 'live' | 'at-rest' = 'live'): void {
  installUnclearedWorker()
  commitClear()
  if (context === 'live') {
    const record = records.get(MINTED)!
    records.set(MINTED, { ...record, lease: liveRecord(MINTED).lease })
    children.add(MINTED)
  }
  journals.get(MINTED)!.push(message('i-post', 'POST-CLEAR (live work)'))
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

function registerWorker(sessionId = MINTED) {
  return structuredWorkerIdentities.register({
    handle: mintStructuredWorkerHandle(),
    sessionId,
    agent: 'claude',
    paneKey: mintStructuredWorkerPaneKey(sessionId),
    processIncarnation: structuredWorkerProcessIncarnation(sessionId),
    worktreeId: 'wt_1',
    hostScope: LOCAL_SCOPE
  })
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
  records.clear()
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
  'a worker cleared in place with provider context %s',
  (context) => {
    beforeEach(() => installClearedWorker(context))

    it('keeps authority on the same conversation', () => {
      const identity = registerWorker()
      expect(resolveStructuredWorkerAuthority(identity.handle, null)?.running.sessionId).toBe(
        MINTED
      )
    })

    it('reports provider liveness separately from conversation custody', () => {
      const identity = registerWorker()
      const expected = context === 'live' ? 'live' : 'exited'
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

    it('serves terminal read from the same complete journal', async () => {
      const identity = registerWorker()
      const read = await readStructuredWorkerTerminal({ handle: identity.handle, db: null })
      expect(historyAsked).toEqual([MINTED])
      const lines = JSON.stringify(read)
      expect(lines.indexOf('PRE-CLEAR')).toBeGreaterThan(-1)
      expect(lines.indexOf('POST-CLEAR')).toBeGreaterThan(lines.indexOf('PRE-CLEAR'))
    })

    it('serves worker-read with both contexts in journal order', async () => {
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

    it('retains the worker when its journal cannot be read', async () => {
      unreadable.add(MINTED)
      await expect(
        captureStructuredWorkerArchive(registerWorker(), 'claude')
      ).rejects.toMatchObject({ code: 'archive_failed' })
      expect(historyAsked).toEqual([MINTED])
    })

    it('shows the same worker conversation in worker-show', async () => {
      const identity = registerWorker()
      const dispatchId = startWorkerDispatch(db, identity)
      const shown = await inspectWorkerTerminal(new OrcaRuntimeService(), db, dispatchId)
      expect(shown).toMatchObject({
        exact: true,
        status: context === 'live' ? 'live' : 'exited',
        addressable: true
      })
    })

    it('closes the same conversation and then proves the provider exited', async () => {
      const identity = registerWorker()
      const stop = await stopStructuredWorker(identity, 'ctx_1')
      expect(closed).toEqual([MINTED])
      expect(stop.stopped).toBe(true)
      structuredWorkerIdentities.clear()
      await expect(
        new OrcaRuntimeService().inspectTerminalProcessIncarnationLiveness(
          identity.processIncarnation,
          JSON.stringify(LOCAL_SCOPE)
        )
      ).resolves.toBe('exited')
    })

    it('reports the current conversation status to @idle', async () => {
      const identity = registerWorker()
      await expect(new OrcaRuntimeService().getAgentStatusForHandle(identity.handle)).resolves.toBe(
        'idle'
      )
      expect(journalAsked).toEqual([MINTED])
    })

    it('stays a group-address recipient', () => {
      const identity = registerWorker()
      startWorkerDispatch(db, identity)
      expect(listAddressableStructuredWorkers(db)).toEqual([
        { handle: identity.handle, worktreeId: 'wt_1', agentIdentity: 'claude' }
      ])
    })

    it('routes direct and Dispatch mail to the same conversation', () => {
      const identity = registerWorker()
      const dispatchId = startWorkerDispatch(db, identity)
      const runtime = new RuntimeProbe().withDb(db)
      expect(runtime.mailTarget(identity.handle)).toEqual({ sessionId: MINTED, dispatchId })
      expect(runtime.mailTarget(`dispatch:${dispatchId}`)).toEqual({
        sessionId: MINTED,
        dispatchId
      })
    })

    it("re-derives the worker's Dispatch mailbox on the same idle edge", () => {
      const identity = registerWorker()
      const dispatchId = startWorkerDispatch(db, identity)
      expect(structuredSessionOwnedMailboxes(MINTED, db)).toContain(`dispatch:${dispatchId}`)
    })

    it('gives the next provider the unchanged worker handle', () => {
      const identity = registerWorker()
      expect(structuredSessionChildIdentityEnv(MINTED, {}).ORCA_TERMINAL_HANDLE).toBe(
        identity.handle
      )
    })

    it('records takeover when the user types after clear', () => {
      const identity = registerWorker()
      expect(new RuntimeProbe().withDb(db).getStructuredWorkerPaneKeyForSession(MINTED)).toBe(
        identity.paneKey
      )
    })

    it("keeps the current provider running for the worker's open Dispatch", () => {
      startWorkerDispatch(db, registerWorker())
      const currentRecord = records.get(MINTED)
      expect(currentRecord && structuredWorkerOwesWork(db, currentRecord)).toBe(true)
    })

    it('finds the worker from its durable row after a restart', () => {
      const identity = registerWorker()
      startWorkerDispatch(db, identity)
      structuredWorkerIdentities.clear()
      expect(new RuntimeProbe().withDb(db).getStructuredWorkerPaneKeyForSession(MINTED)).toBe(
        identity.paneKey
      )
      structuredWorkerIdentities.clear()
      expect(resolveStructuredWorkerAuthority(identity.handle, db)?.running.sessionId).toBe(MINTED)
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

  it('and so is typing after clear, reported by the same conversation', async () => {
    installClearedWorker('live')
    const identity = registerWorker()
    const dispatchId = startWorkerDispatch(db, identity)
    const { call } = rpcRuntime(db)
    await expect(
      call('orchestration.workerTerminalUserInput', { sessionId: MINTED })
    ).resolves.toEqual({ changed: 1 })
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      ownership_state: 'user_owned'
    })
  })
})

describe('a separate conversation no agent ever ran', () => {
  beforeEach(() => installSessions([foundedRecord(UNSTARTED)], [UNSTARTED]))

  it('is unverifiable while listed and exited once its chat is gone', () => {
    const identity = registerWorker(UNSTARTED)
    expect(observeStructuredWorker(identity).status).toBe('unverifiable')
    visibleTabs = []
    expect(observeStructuredWorker(identity).status).toBe('exited')
  })

  it.each([false, true])(
    'releases after a stop even if history reopened it: %s',
    async (readBetween) => {
      const identity = registerWorker(UNSTARTED)
      const { runtime, call } = rpcRuntime(db)
      const dispatchId = startWorkerDispatch(db, identity, runtime.getRuntimeId())
      await expect(
        call('orchestration.workerStop', { dispatch: dispatchId })
      ).resolves.toMatchObject({ state: 'stopped' })
      if (readBetween) {
        await readJournal(identity)
        expect(open.has(UNSTARTED)).toBe(true)
      }
      structuredWorkerIdentities.clear()
      await expect(
        call('orchestration.workerRelease', { dispatch: dispatchId })
      ).resolves.toMatchObject({ state: 'released' })
    }
  )

  it('stays unverifiable when its tab index cannot be read', () => {
    visibleTabs = []
    tabIndexPresent = false
    expect(observeStructuredSession(UNSTARTED).status).toBe('unverifiable')
  })

  it('stays unverifiable if restored from a backup that may have lost a reservation', () => {
    visibleTabs = []
    const founded = foundedRecord(UNSTARTED)
    records.set(UNSTARTED, { ...founded, lease: { ...founded.lease, minimumNextFence: 3 } })
    expect(observeStructuredSession(UNSTARTED).status).toBe('unverifiable')
  })
})

describe('a released session whose start was attempted stays unverifiable without proof', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-unstarted-worker-'))
    installSessions([foundedRecord(UNSTARTED)], [])
    visibleTabs = []
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  async function reserveUnstarted(operationId: string) {
    const store = await openTestAgentSessionRecordStore(directory)
    const reserved = await store.reserveOwner({
      sessionId: UNSTARTED,
      location: liveRecord(UNSTARTED).location,
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
    const { reserved } = await reserveUnstarted(OPERATION_ID)
    const recovered = applyAgentSessionRestartAdjudication({
      record: reserved,
      probe: { outcome: 'indeterminate', reason: 'no answer' },
      now: NOW + 1
    })
    expect(recovered.lease).toMatchObject({ claimStatus: 'released', deathEvidence: null })
    records.set(UNSTARTED, recovered)
    expect(observeStructuredSession(UNSTARTED).status).toBe('unverifiable')
  })

  it('after a failed first start whose exit was not proven', async () => {
    const { store, reserved } = await reserveUnstarted(OPERATION_ID)
    const settled = await store.settleFailedAcquisition({
      sessionId: UNSTARTED,
      fence: reserved.lease.runtimeFence,
      spawnToken: 'spawn-a',
      callerKey: 'client-1',
      operationId: OPERATION_ID,
      outcome: { status: 'failed', code: 'agent_session_operation_invalid', message: 'failed' },
      exitProof: 'unproven',
      now: NOW + 1
    })
    expect(settled.lease).toMatchObject({ claimStatus: 'released', deathEvidence: null })
    records.set(UNSTARTED, settled)
    expect(observeStructuredSession(UNSTARTED).status).toBe('unverifiable')
  })
})

describe('stopping a worker while a /clear commits', () => {
  beforeEach(() => {
    installUnclearedWorker()
    clearDuringClose = true
  })

  it('closes the same conversation once after the queued clear', async () => {
    const stop = await stopStructuredWorker(registerWorker(), 'ctx_1')
    expect(closed).toEqual([MINTED])
    expect(stop.stopped).toBe(true)
  })

  it('claims no close when tab hiding fails before the queued clear', async () => {
    failHideOf = MINTED
    const stop = await stopStructuredWorker(registerWorker(), 'ctx_1')
    expect(closed).toEqual([])
    expect(stop).toMatchObject({ stopped: false, closeAttempted: false })
  })

  it('stops through worker-stop when the old session already reads exited mid-clear', async () => {
    // The old provider exited before the clear transaction committed.
    children.delete(MINTED)
    const base = clearedRecord(MINTED)
    const { conversationCommand: _uncommitted, ...stoppedForClear } = base
    records.set(MINTED, stoppedForClear)
    const identity = registerWorker()
    const { runtime, call } = rpcRuntime(db)
    const dispatchId = startWorkerDispatch(db, identity, runtime.getRuntimeId())
    await expect(call('orchestration.workerStop', { dispatch: dispatchId })).resolves.toMatchObject(
      { state: 'stopped', processAction: 'closed_agent_terminal' }
    )
    expect(closed).toEqual([MINTED])
  })
})

describe('worker-stop on a structured worker that reads exited without any /clear', () => {
  it("closes and hides the crashed agent's still-listed chat, and settles stopped", async () => {
    const { conversationCommand: _none, ...crashed } = clearedRecord(MINTED)
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

describe.each([1, 2])(
  'a retired conversation cleared %s times with an unreadable journal',
  (clears) => {
    beforeEach(() => {
      installUnclearedWorker()
      for (let index = 0; index < clears; index += 1) {
        commitClear()
      }
      visibleTabs = []
      unreadable.add(MINTED)
    })

    it('keeps an empty archive with the existing singular closed-session warning', async () => {
      const archive = await captureStructuredWorkerArchive(registerWorker(), 'claude')
      expect(archive.messages).toEqual([])
      expect(archive.warnings).toEqual([
        'The structured session was already closed, so its journal could not be preserved.'
      ])
      expect(historyAsked).toEqual([MINTED])
    })

    it('commits that archive on release without reading another conversation', async () => {
      const dispatchId = startWorkerDispatch(db, registerWorker())
      await expect(releaseSucceeded(dispatchId)).resolves.toMatchObject({ state: 'released' })
      const content = db.getWorkerTerminalArchive(dispatchId)?.content ?? ''
      expect(content).toContain('"messages":[]')
      expect(content).toContain('already closed')
      expect(historyAsked).toEqual([MINTED])
    })
  }
)

describe('the worker-read cursor across a /clear', () => {
  it('stays valid when the clear divider and next-context messages append after its prefix', async () => {
    installUnclearedWorker()
    journals.set(MINTED, [message('i1', 'PRE-CLEAR (dispatch work)')])
    const identity = registerWorker()
    const before = await readJournal(identity)
    expect(before.transcript?.returnedMessageCount).toBe(1)
    commitClear()
    journals.get(MINTED)!.push(message('i2', 'POST-CLEAR (live work)'))
    const after = await readJournal(identity, before.cursor ?? undefined)
    expect(texts(after.transcript?.messages)).toContain('POST-CLEAR')
    expect(texts(after.transcript?.messages)).not.toContain('PRE-CLEAR')
  })
})

describe('the cleared conversation journal page', () => {
  beforeEach(() => installClearedWorker('live'))

  it('keeps one newest page across retained contexts and reports older omitted history', async () => {
    const rows = Array.from({ length: 300 }, (_, index) => message(`i-${index}`, `${index}`))
    journals.set(MINTED, rows)
    const page = await readStructuredJournalPage(MINTED)
    expect(page?.items).toHaveLength(STRUCTURED_JOURNAL_PAGE_LIMIT)
    expect(page?.items[0]?.itemId).toBe('i-100')
    expect(page?.items.at(-1)?.itemId).toBe('i-299')
    expect(page?.hasOlder).toBe(true)
    expect(historyAsked).toEqual([MINTED])
  })

  it('refuses an unreadable actual journal instead of substituting other output', async () => {
    unreadable.add(MINTED)
    await expect(readJournal(registerWorker())).rejects.toMatchObject({
      code: 'transcript_required'
    })
    expect(historyAsked).toEqual([MINTED])
  })
})

describe('a worker cleared twice', () => {
  beforeEach(() => {
    installClearedWorker('live')
    commitClear()
  })

  it('reads and closes the same conversation once', async () => {
    const identity = registerWorker()
    expect(resolveStructuredWorkerAuthority(identity.handle, null)?.running.sessionId).toBe(MINTED)
    await readJournal(identity)
    expect(historyAsked).toEqual([MINTED])
    await stopStructuredWorker(identity, 'ctx_1')
    expect(closed).toEqual([MINTED])
  })

  it('forgets only the actual conversation mail after restart', () => {
    const forgetStructuredSessionMail = vi.fn()
    releaseStructuredWorkerSession('ctx_after_restart', { forgetStructuredSessionMail }, MINTED)
    expect(forgetStructuredSessionMail.mock.calls).toEqual([[MINTED]])
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

  function installMissingConversation(): void {
    installSessions([], [MINTED])
  }

  it('when the actual conversation has no record', async () => {
    installMissingConversation()
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
    installMissingConversation()
    const dispatchId = startWorkerDispatch(db, registerWorker())
    await expect(releaseSucceeded(dispatchId)).resolves.toMatchObject({
      state: 'release_unknown',
      processAction: 'none'
    })
    expect(db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('unknown')
  })

  it('ignores a legacy self-pointer rather than declaring the actual record unverifiable', async () => {
    const current = clearedRecord(MINTED)
    const older = {
      ...current,
      conversationCommand: { ...current.conversationCommand!, replacementSessionId: MINTED }
    }
    installSessions([older], [MINTED])
    const identity = registerWorker()
    expect(observeStructuredWorker(identity).status).toBe('exited')
    expect(structuredSessionMailTarget(MINTED, null)).toEqual({
      sessionId: MINTED,
      dispatchId: null
    })
    const store = { getRecord: (id: string) => records.get(id) ?? null, listRecords: () => [] }
    expect(structuredSessionMailReach(store, older, null)).toMatchObject({
      kind: 'reachable',
      session: older
    })
    await readJournal(identity)
    expect(historyAsked).toEqual([MINTED])
  })

  it('when the structured host is not installed', async () => {
    hostRef.current = null
    const identity = registerWorker()
    await expect(readJournal(identity)).rejects.toMatchObject({ code: 'session_caller_not_live' })
    await expect(captureStructuredWorkerArchive(identity, 'claude')).rejects.toMatchObject({
      code: 'session_caller_not_live'
    })
  })

  it('with the host-boundary refusal when the actual conversation belongs to another host', async () => {
    installClearedWorker()
    const current = records.get(MINTED)
    if (current) {
      records.set(MINTED, {
        ...current,
        location: { ...current.location, executionHostId: 'ssh:box' }
      })
    }
    const identity = registerWorker()
    expect(observeStructuredWorker(identity).status).toBe('unverifiable')
    await expectRefused(identity, 'session_caller_host_boundary')
  })
})
