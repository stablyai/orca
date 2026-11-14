import { agentSessionConversationView } from '../../../../../shared/agent-session/lifecycle/agent-session-conversation-view'
/** Worker-level reads/operations follow clear successors and the full lineage; unresolved successors remain unverifiable. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock(
  '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry',
  () => ({
    getStructuredAgentSessionHost: () => hostRef.current
  })
)

const { readStructuredWorkerTerminal } = await import('./structured-worker-terminal-read')
const {
  observeStructuredWorker,
  resolveStructuredWorkerAuthority,
  resolveStructuredWorkerIdentityForSession
} = await import('./structured-worker-authority')
const { structuredSessionMailTarget } =
  await import('../../mailbox/routing/structured-session-mail-target')
const { structuredSessionMailReach } =
  await import('../../mailbox/routing/structured-session-mail-address')
const { captureWorkerOutputReference } =
  await import('../../workers/archives/worker-output-archive')
const { encodeWorkerOutputCursor } = await import('../../workers/transcripts/worker-output-cursor')
const { stopStructuredWorker, readStructuredWorkerJournal } =
  await import('../../../rpc/methods/orchestration/structured-workers/orchestration-structured-worker-lifecycle')
await import('../../../rpc/methods/orchestration/structured-workers/orchestration-structured-worker-session')
await import('../../../rpc/methods/orchestration/worker/observation/worker-observation')
await import('../../addressing/groups/structured-worker-group-addressing')
const { readStructuredLineageJournalPage, STRUCTURED_JOURNAL_PAGE_LIMIT } =
  await import('../../workers/archives/structured-worker-journal-page')
await import('../../../agent-session/environment/structured-session-child-env.test-support')
const { foundAgentSessionRecord } =
  await import('../../../agent-session/records/agent-session-record-founding')
const { OrcaRuntimeService } = await import('../../../orca-runtime')
const { OrchestrationDb } = await import('../../db/orchestration-db')
const { rpcRuntime } = await import('./structured-worker-rpc.test-support')
await import('./structured-worker-custody')
await import('../../../../native-chat/agent-session-wire/operations/structured-agent-session-mutation-admission')
const { AGENT_SESSION_NOT_ATTACHED } =
  await import('../../../../native-chat/agent-session-wire/operations/structured-agent-session-mutation-refusals')
const {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} = await import('./structured-worker-identity')

type Db = InstanceType<typeof OrchestrationDb>

const MINTED = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const SUCCESSOR = 'clear-a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const SECOND = 'clear-ffeeddccbbaa99887766554433221100ffeeddcc'
const LOCAL_SCOPE = { kind: 'local', hostId: 'local' } as const

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
        getConversation: (id: string) => {
          const record = records.get(id)
          return record ? agentSessionConversationView(record) : null
        },
        listConversations: () => [...records.values()].map(agentSessionConversationView),
        requireWritableRecord: (id: string) => {
          const record = records.get(id)
          if (!record) {
            throw new Error('Missing test record')
          }
          return record
        },
        listRecords: () => [...records.values()],
        getVisibleSessionTabIndex: () => ({ present: tabIndexPresent, sessionIds: visibleTabs }),
        getSessionTabId: () => null
      },
      logger: { warn: () => {} }
    },
    getSessionTabId: (id: string) => (visibleTabs.includes(id) ? `agent-session:${id}` : null),
    hasSession: (id: string) => open.has(id) || children.has(id),
    getPersistedVisibleSessionTabIndex: () => ({
      present: tabIndexPresent,
      sessionIds: visibleTabs
    }),
    journalCurrentRead: async (id: string) => {
      journalAsked.push(id)
      if (!records.has(id)) {
        throw new Error(AGENT_SESSION_NOT_ATTACHED.code)
      }
      open.add(id)
      return { items: [message(`${id}-1`, 'idle')], submissions: [] }
    },
    // No projection held: the gate reads the timeline as it stands.
    currentWork: () => null,
    setSessionTabVisibility: async (id: string, visible: boolean) => {
      if (id === failHideOf) {
        throw new Error('the durable tab index is wedged')
      }
      visibleTabs = visible ? [...visibleTabs, id] : visibleTabs.filter((tab) => tab !== id)
    },
    // Model real close: stop attached children with evidence, then drop the conversation.
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

const texts = (messages: readonly { blocks: readonly unknown[] }[] | undefined): string =>
  JSON.stringify(messages ?? [])

let db: Db

beforeEach(() => {
  // This fixture has no raw layout; visibility and lease proof remain host-owned.
  const p = OrcaRuntimeService.prototype
  vi.spyOn(p, 'captureStructuredAgentSessionPresentation').mockReturnValue({ raw: null, saved: [] })
  vi.spyOn(p, 'currentLocalStructuredSessionPresentation').mockReturnValue(null)
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

    it('reads the whole conversation from its chat once released, keeping no copy', async () => {
      const dispatchId = startWorkerDispatch(db, registerWorker())
      await expect(releaseSucceeded(dispatchId)).resolves.toMatchObject({ state: 'released' })
      const read = await rpcRuntime(db).call('orchestration.workerRead', { dispatch: dispatchId })
      expect(read).toMatchObject({ source: 'transcript', archived: true })
      const history = JSON.stringify(read)
      expect(history.indexOf('PRE-CLEAR')).toBeGreaterThan(-1)
      expect(history.indexOf('POST-CLEAR')).toBeGreaterThan(history.indexOf('PRE-CLEAR'))
      expect(db.getWorkerTerminalArchive(dispatchId)?.content).not.toContain('CLEAR')
      // A cursor refusal keeps its own code; it never reads as lost output.
      const foreign = encodeWorkerOutputCursor('ctx_other', 'transcript', 'identity', 1)
      await expect(
        rpcRuntime(db).call('orchestration.workerRead', { dispatch: dispatchId, cursor: foreign })
      ).rejects.toMatchObject({ code: 'cursor_dispatch_mismatch' })
    })

    it('finds the worker from its durable row after a restart', () => {
      const identity = registerWorker()
      startWorkerDispatch(db, identity)
      structuredWorkerIdentities.clear()
      expect(resolveStructuredWorkerIdentityForSession(SUCCESSOR, db)?.paneKey).toBe(
        identity.paneKey
      )
      structuredWorkerIdentities.clear()
      expect(resolveStructuredWorkerAuthority(identity.handle, db)?.running.sessionId).toBe(
        SUCCESSOR
      )
    })
  }
)

describe('a successor no agent ever ran', () => {
  beforeEach(() => installClearedWorker('at-rest'))

  it.each([true])(
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
})

describe('stopping a worker while a /clear commits', () => {
  beforeEach(() => {
    installUnclearedWorker()
    clearDuringClose = true
  })

  it('closes the successor the clear handed the worker to', async () => {
    const stop = await stopStructuredWorker(registerWorker())
    expect(closed).toEqual([MINTED, SUCCESSOR])
    expect(stop.stopped).toBe(true)
  })

  it('keeps provider Stop proved when the successor hide fails', async () => {
    failHideOf = SUCCESSOR
    const stop = await stopStructuredWorker(registerWorker())
    expect(closed).toEqual([MINTED, SUCCESSOR])
    expect(stop).toMatchObject({ stopped: true, closeAttempted: true })
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

describe.each([{ clears: 2 }])(
  'a retired lineage of $clears clear(s) whose later sessions cannot be read',
  (lineage) => {
    beforeEach(() => {
      // The user closed the cleared chat, and every journal after the first is gone.
      const later = lineage.clears === 1 ? [SUCCESSOR] : [SUCCESSOR, SECOND]
      const newest = later.at(-1) ?? SUCCESSOR
      const chain = lineage.clears === 1 ? [] : [clearedRecord(SUCCESSOR, SECOND)]
      installSessions([clearedRecord(MINTED, SUCCESSOR), ...chain, foundedRecord(newest)], [])
      later.forEach((sessionId) => unreadable.add(sessionId))
    })

    it('releases, then says the output is no longer available instead of reading nothing', async () => {
      const dispatchId = startWorkerDispatch(db, registerWorker())
      await expect(releaseSucceeded(dispatchId)).resolves.toMatchObject({ state: 'released' })
      await expect(
        rpcRuntime(db).call('orchestration.workerRead', { dispatch: dispatchId })
      ).rejects.toMatchObject({ code: 'archive_unavailable' })
    })
  }
)

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
    await stopStructuredWorker(identity)
    expect(closed).toEqual([SECOND])
  })
})

describe('a running session that cannot be verified is refused, never declared exited', () => {
  async function expectRefused(identity: ReturnType<typeof registerWorker>, code: string) {
    await expect(readJournal(identity)).rejects.toMatchObject({ code })
    expect(() =>
      captureWorkerOutputReference({
        runtime: { getExactWorkerProviderSession: () => null },
        terminalHandle: identity.handle,
        attachedAtMs: 0,
        structuredWorker: identity
      })
    ).toThrow(expect.objectContaining({ code }))
    await expect(
      readStructuredWorkerTerminal({ handle: identity.handle, db: null })
    ).rejects.toMatchObject({ code })
    const stop = await stopStructuredWorker(identity)
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
    const store = {
      getRecord: (id: string) => {
        const record = records.get(id)
        return record ? agentSessionConversationView(record) : null
      },
      listRecords: () => []
    }
    expect(
      mintedRecord &&
        structuredSessionMailReach(store, agentSessionConversationView(mintedRecord), null)
    ).toMatchObject({
      kind: 'unverifiable'
    })
    await expectRefused(identity, 'session_caller_not_live')
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
