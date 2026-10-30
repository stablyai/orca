import { afterEach, expect, it, vi } from 'vitest'
import { createOrchestrationRpcHarness } from './rpc-test-harness'
import { partialRuntimeStore } from '../../../runtime-store-partial-fixture'
import { resolveOrchestrationSessionCaller } from '../../orchestration-session-caller'
import { setStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from '../../../../native-chat/agent-session-wire/structured-agent-session-queued-message-rig.test-fixture'
import {
  hostTestAttachParams,
  hostTestOperationId
} from '../../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { testOrcaSessionId } from '../../../../../shared/orca-session-address-test-fixture'
import { projectStructuredAgentStartItem } from '../../../../../shared/structured-agent-start-projection'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody
} from '../../../../../shared/agent-session-journal-types'
import {
  closeTestJournalHostDatabase,
  openTestJournalHostDatabase
} from '../../../../native-chat/agent-session-journal/journal-host-database-test-support'
import * as journalSchema from '../../../../native-chat/agent-session-journal/journal-row-schema'
import { StructuredAgentSessionJournalProjections } from '../../../../native-chat/agent-session-wire/structured-agent-session-status-journal-projection'
import { installSqlVisitCounters } from '../../../dispatch-predicate-visits.test-fixture'
import { createMinimalPersistedTerminalTab } from '../../../../persistence/restoring-sessions/session-owner-fields'
import { getDefaultWorkspaceSession } from '../../../../../shared/constants'
import { readFile } from 'node:fs/promises'
import { projectStructuredAgentSessionStatusSummary } from '../../../../../shared/structured-agent-session-projection'
import { prepareWorkerStartCard } from '../../../orchestration/worker-start-card'
import * as placement from './worker/worker-start-agent-placement'
import * as topology from './worker/worker-topology'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
} from '../../../../../shared/protocol-version'

const h = createOrchestrationRpcHarness()
const COORD = testOrcaSessionId('start-card-caller')
const WORKER = testOrcaSessionId('start-card-worker')
let rig: QueuedMessageTestRig | undefined
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig?.dispose()
  rig = undefined
  h.cleanup()
  vi.restoreAllMocks()
})

it.each([
  'success',
  'failure',
  'readiness-failure',
  'append-throws',
  'append-pending',
  'logging-throws',
  'reuse',
  'dispatch',
  'context-only',
  'cleared-context',
  'federated',
  'federated-unknown'
] as const)(
  'real worker-start records creation independently of launch: %s',
  async (scenario) => {
    rig = await createQueuedMessageTestRig({ sessionId: WORKER })
    const current = rig
    if (scenario === 'readiness-failure') {
      current.dispatch.mockRejectedValueOnce(new Error('provider dispatch failed'))
    }
    const federated = scenario === 'federated' || scenario === 'federated-unknown'
    setStructuredAgentSessionHost(current.host)
    expect(
      await current.host.attach(
        QUEUED_RIG_CALLER,
        hostTestAttachParams(null, {
          envelope: {
            sessionId: COORD,
            clientOperationId: hostTestOperationId(),
            expectedRuntimeFence: null,
            payloadFingerprint: ''
          }
        })
      )
    ).toMatchObject({ ok: true })
    const { runtime, db } = h.setup(
      false,
      partialRuntimeStore({ getSettings: () => ({ experimentalNativeChat: false }) })
    )
    if (federated) {
      vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
        environmentId: 'remote',
        name: 'remote',
        peerFingerprint: 'peer',
        pairingRevision: 1
      })
      vi.spyOn(runtime, 'ensureOrchestrationFederationRelay').mockImplementation(() => {})
      vi.spyOn(runtime, 'callOrchestrationWorkerServer').mockImplementation(
        async (_host, method, params) => {
          if (method === 'status.get') {
            return {
              capabilities: [
                ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
                ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
              ]
            }
          }
          if (!params || typeof params !== 'object' || !('dispatchId' in params)) {
            throw new Error('missing remote dispatch')
          }
          return {
            dispatchId: params.dispatchId,
            state: scenario === 'federated' ? 'ready' : 'outcome_unknown',
            runtimeEpoch: 'remote-epoch',
            worktreeId: 'remote-workspace',
            terminalHandle: 'term_remote'
          }
        }
      )
    }
    vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue()
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    type WorkspaceLookup = {
      showManagedTerminalWorkspace: (
        ...args: Parameters<typeof runtime.showManagedTerminalWorkspace>
      ) => Promise<placement.WorkerAgentPlacement['worktree']>
    }
    vi.spyOn<WorkspaceLookup, 'showManagedTerminalWorkspace'>(
      runtime,
      'showManagedTerminalWorkspace'
    ).mockResolvedValue({ id: 'workspace-1', repoId: 'repo' })
    vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({
      supported: true
    })
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockReturnValue({
      runtimeId: runtime.getRuntimeId(),
      terminalHandle: 'term_worker',
      ptyId: 'pty',
      worktreeId: 'workspace-1',
      paneKey: 'tab:11111111-1111-4111-8111-111111111111',
      processIncarnation: 'fixture:1',
      launchTokenHash: null,
      hostScope: { kind: 'local', hostId: 'local' }
    })
    vi.spyOn(topology, 'monitorWorkerSetup').mockImplementation(() => {})
    vi.spyOn(placement, 'placeWorkerAgent').mockImplementation(async (args) => {
      if (scenario === 'failure') {
        throw new Error('placement failed')
      }
      return {
        mode: args.mode,
        worktree: { id: 'workspace-1', repoId: 'repo' },
        terminalHandle: 'term_worker',
        structuredSession: {
          host: current.host,
          identity: {
            sessionId: WORKER,
            handle: 'term_worker',
            agent: args.agent ?? null,
            paneKey: 'tab:11111111-1111-4111-8111-111111111111',
            processIncarnation: 'fixture:1',
            worktreeId: 'workspace-1',
            hostScope: { kind: 'local', hostId: 'local' }
          },
          fence: current.store.requireWritableRecord(WORKER).lease.runtimeFence
        },
        setupReceipt: placement.EXISTING_WORKTREE_SETUP
      }
    })
    const run = db.createRun({
      objective: 'cards',
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: COORD
    })
    const append = vi.spyOn(current.host, 'appendAgentStart')
    const pending = Promise.withResolvers<void>()
    if (scenario === 'append-throws' || scenario === 'logging-throws') {
      append.mockRejectedValueOnce(new Error('journal unavailable'))
    } else if (scenario === 'append-pending') {
      append.mockReturnValueOnce(pending.promise)
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation((message) => {
      if (
        scenario === 'logging-throws' &&
        message === '[orchestration] recording a started worker in its caller chat failed'
      ) {
        throw new Error('logger failed')
      }
    })
    const task = `  Full task 🐋\r\n${'task content\n'.repeat(9000)}END  `
    const dispatch = scenario === 'dispatch' || scenario === 'context-only'
    const method = dispatch ? 'orchestration.dispatch' : 'orchestration.workerStart'
    const admitted = await resolveOrchestrationSessionCaller(
      runtime,
      {
        id: 'start-card',
        authToken: 'test-token',
        method,
        params: dispatch
          ? {
              task: db.createTask({ runId: run.id, spec: task }).id,
              to: `orca_session_id:${WORKER}`,
              inject: scenario === 'dispatch',
              returnPreamble: true
            }
          : {
              spec: task,
              ...(scenario === 'reuse' ? {} : { agent: 'codex' }),
              timeoutMs: 1000,
              ...(federated ? { on: 'remote', worktree: 'id:remote-workspace' } : {}),
              ...(scenario === 'reuse' ? { terminal: `orca_session_id:${WORKER}` } : {})
            },
        orchestrationCompatibilityEvidence: { agentSessionId: COORD }
      },
      undefined
    )
    const callerJournal = current.host.collaboratorsForTests().sessions.get(COORD)!.journal
    const callerBodies: AgentJournalItemBody[] = [
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Coordinate this work' }] },
      { kind: 'tool-call', name: 'shell', input: { command: 'inspect' }, state: 'running' }
    ]
    for (const [index, body] of callerBodies.entries()) {
      await callerJournal.appendItem(
        { provider: 'orca', clientMessageId: `caller-${index}` },
        body,
        {
          fence: current.store.getConversation(COORD)!.currentFence,
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        }
      )
    }
    const before = await current.host.journalSnapshot(COORD)
    const rpc = h.findMethod(method)
    const running = rpc.handler(rpc.params?.parse(admitted.request.params), {
      runtime,
      orchestrationCaller: admitted.caller,
      orchestrationCompatibilityEvidence: admitted.request.orchestrationCompatibilityEvidence,
      ...(federated
        ? {
            orchestrationMutation: {
              callerFingerprint: 'caller',
              requestId: 'start-request',
              method,
              payloadHash: 'payload'
            }
          }
        : {})
    })
    if (scenario !== 'failure' && scenario !== 'context-only' && !federated) {
      await eventually(() => expect(current.dispatch).toHaveBeenCalled())
      expect(append).not.toHaveBeenCalled()
      if (scenario === 'cleared-context') {
        const getConversation = current.store.getConversation
        vi.spyOn(current.store, 'getConversation').mockImplementation((id) => {
          const record = getConversation(id)
          return record && id === COORD
            ? {
                ...record,
                providerContextBoundary: {
                  operationId: 'later-clear',
                  afterFence: record.currentFence,
                  clearedAt: 1700000000000
                }
              }
            : record
        })
      }
      if (scenario !== 'readiness-failure') {
        await current.settleAccepted(current.dispatch.mock.calls[0][0].clientMessageId, 'task-turn')
      }
    }
    const result = await running
    if (scenario === 'readiness-failure') {
      expect(result).not.toMatchObject({ state: 'ready' })
    } else if (!dispatch) {
      expect(result).toMatchObject({
        state:
          scenario === 'failure'
            ? 'failed'
            : scenario === 'federated-unknown'
              ? 'outcome_unknown'
              : 'ready'
      })
    }
    // A pending display append must not hold the successful RPC; release it only after the reply.
    if (scenario === 'append-pending') {
      expect(append).toHaveBeenCalledTimes(1)
      pending.resolve()
    }
    if (scenario === 'append-throws' || scenario === 'logging-throws') {
      await eventually(() =>
        expect(warn).toHaveBeenCalledWith(
          '[orchestration] recording a started worker in its caller chat failed',
          expect.any(Error)
        )
      )
    }
    if (scenario === 'success' || scenario === 'federated') {
      await eventually(async () =>
        expect(
          (await current.host.journalSnapshot(COORD)).items.some(
            (item) => item.body.kind === 'agent-start'
          )
        ).toBe(true)
      )
    }
    const snapshot = await current.host.journalSnapshot(COORD)
    const cards = snapshot.items.filter((item) => item.body.kind === 'agent-start')
    if (scenario !== 'success' && scenario !== 'federated') {
      expect(cards).toHaveLength(0)
      return
    }
    expect(cards).toHaveLength(1)
    const [card] = cards
    expect(snapshot.items.map(({ itemId }) => itemId)).toEqual([
      ...before.items.map(({ itemId }) => itemId),
      card.itemId
    ])
    expect(card.body).toMatchObject({
      kind: 'agent-start',
      task,
      ...(!federated
        ? { worker: { party: { address: 'term_worker', terminalHandle: 'term_worker' } } }
        : {})
    })
    if (card.body.kind !== 'agent-start') {
      throw new Error('missing start body')
    }
    if (federated) {
      expect(card.body.worker.party.address).toBe(`dispatch:${card.body.dispatchId}`)
    }
    const destination = append.mock.calls[0][0]
    await Promise.all([
      current.host.appendAgentStart(
        destination,
        { ...card.body, task: 'replayed task' },
        card.observedAt + 10
      ),
      current.host.appendAgentStart(destination, card.body, card.observedAt + 20)
    ])
    expect(
      (await current.host.journalSnapshot(COORD)).items.filter(
        (item) => item.body.kind === 'agent-start'
      )
    ).toEqual(cards)
    expect(projectStructuredAgentStartItem(card)).toMatchObject({
      role: 'system',
      agentStart: true,
      timestamp: card.observedAt,
      blocks: [{ type: 'text', text: task }]
    })
    expect(
      projectStructuredAgentSessionStatusSummary(snapshot.items, snapshot.submissions)
    ).toEqual(projectStructuredAgentSessionStatusSummary(before.items, before.submissions))
    // Full task survives removal of the orchestration rows it came from.
    db.resetAll()
    expect(
      (await current.host.journalSnapshot(COORD)).items.find((item) => item.itemId === card.itemId)
    ).toEqual(card)
    if (scenario === 'success') {
      const context = await current.host.continuationContext({
        sessionId: COORD,
        workspaceId: current.store.getConversation(COORD)!.location.workspaceId,
        expectedCursor: snapshot.cursor
      })
      expect(context).toMatchObject({ status: 'current' })
      if (context.status !== 'current' || !context.transcriptPath) {
        throw new Error('saved context missing')
      }
      const saved = await readFile(context.transcriptPath, 'utf8')
      expect(saved).toContain('Coordinate this work')
      expect(saved).not.toContain(task)
      expect(context.capturedText).not.toContain(task)
      await current.quitRestartHostProcess()
      closeTestJournalHostDatabase(current.root)
      current.crashRestartHostProcess()
      const reopened = await current.host.journalSnapshot(COORD)
      expect(reopened.items.map(({ itemId }) => itemId)).toEqual(
        snapshot.items.map(({ itemId }) => itemId)
      )
      expect(reopened.items.filter(({ body }) => body.kind !== 'tool-call')).toEqual(
        snapshot.items.filter(({ body }) => body.kind !== 'tool-call')
      )
      const recovered = reopened.items.find(({ itemId }) => itemId === 'orca:caller-1')
      expect(recovered).toEqual({
        ...snapshot.items[1],
        revision: snapshot.items[1].revision + 1,
        recovered: true,
        recoveredAt: expect.any(Number),
        body: {
          kind: 'tool-call',
          name: 'shell',
          input: { command: 'inspect' },
          state: 'failed',
          endedAs: 'interrupted'
        }
      })
      expect(reopened.cursor.epoch).toBe(snapshot.cursor.epoch)
      expect(reopened.cursor.sequence).toBeGreaterThan(snapshot.cursor.sequence)
      const history = await current.host.history({ sessionId: COORD, direction: 'tail' })
      expect(history).toMatchObject({ ok: true, page: { items: reopened.items } })
    }
    const journal = current.host.collaboratorsForTests().sessions.get(COORD)!.journal
    if (scenario === 'success') {
      for (let index = 0; index < 3; index++) {
        await journal.appendItem(
          { provider: 'orca', clientMessageId: `pressure-${index}` },
          {
            kind: 'message',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'x'.repeat(750000) }]
          },
          {
            fence: current.store.getConversation(COORD)!.currentFence,
            turnScope: AGENT_JOURNAL_THREAD_SCOPE
          }
        )
      }
      const tail = await current.host.history({ sessionId: COORD, direction: 'tail' })
      if (!tail.ok) {
        throw new Error('pressure tail missing')
      }
      expect(tail.page.hasOlder).toBe(true)
      expect(tail.page.items.some(({ itemId }) => itemId === card.itemId)).toBe(false)
      const older = await current.host.history({
        sessionId: COORD,
        direction: 'before',
        cursor: tail.page.window.nextCursor
      })
      if (!older.ok) {
        throw new Error('pressure older page missing')
      }
      expect(older.page.items.find(({ itemId }) => itemId === card.itemId)).toEqual(card)
    }
    await journal.appendTombstone(
      { provider: 'orca', clientMessageId: `agent-start:${card.body.dispatchId}` },
      { fence: current.store.getConversation(COORD)!.currentFence }
    )
    if (scenario === 'success') {
      await current.quitRestartHostProcess()
      closeTestJournalHostDatabase(current.root)
      current.crashRestartHostProcess()
    }
    await current.host.appendAgentStart(destination, card.body, card.observedAt + 30)
    expect(
      (await current.host.journalSnapshot(COORD)).items.some((item) => item.itemId === card.itemId)
    ).toBe(false)
  },
  20_000
)

it.each([10, 100])(
  'counts populated producer source and journal operations for %i starts and duplicate publications',
  async (count) => {
    rig = await createQueuedMessageTestRig({ sessionId: COORD })
    const current = rig
    setStructuredAgentSessionHost(current.host)
    const session = getDefaultWorkspaceSession()
    const { runtime, db } = h.setup(
      false,
      partialRuntimeStore({
        getSettings: () => ({ experimentalNativeChat: false }),
        getWorkspaceSession: () => session
      })
    )
    vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue()
    const run = db.createRun({
      objective: 'scale',
      coordinatorHandle: null,
      coordinatorPaneKey: null
    })
    const tabs: ReturnType<typeof createMinimalPersistedTerminalTab>[] = []
    const facts: { dispatchId: string; workerAddress: string; task: string; name: string }[] = []
    for (let index = 0; index < 10 * count; index++) {
      const handle = `term_scale_${index}`
      const tabId = `scale-tab-${index}`
      const leafId = `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`
      tabs.push(
        createMinimalPersistedTerminalTab({
          worktreeId: 'workspace-1',
          tabId,
          ptyId: `pty-${index}`,
          existingTabCount: index
        })
      )
      runtime.handles.set(handle, {
        handle,
        runtimeId: runtime.getRuntimeId(),
        rendererGraphEpoch: 1,
        worktreeId: 'workspace-1',
        tabId,
        leafId,
        ptyId: null,
        ptyGeneration: 0,
        issuedForPaneKey: `${tabId}:${leafId}`
      })
      const task = db.createTask({
        runId: run.id,
        spec: `Task ${index}`,
        displayName: `Scale worker ${index}`
      })
      const { dispatch } = db.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskId: task.id,
        startOptions: {}
      })
      db.prepareStartingWorkerAuthority({
        dispatchId: dispatch.id,
        handle,
        paneKey: `${tabId}:${leafId}`,
        processIncarnation: `scale:${index}`,
        worktreeId: 'workspace-1',
        effects: [],
        setupState: 'not_applicable'
      })
      db.markWorkerDispatchReady(dispatch.id)
      if (index >= 9 * count) {
        facts.push({
          dispatchId: dispatch.id,
          workerAddress: handle,
          task: task.spec,
          name: `Scale worker ${index}`
        })
      }
    }
    let tabVisits = 0
    tabs.forEach((tab, index) => {
      Object.defineProperty(tabs, index, {
        get() {
          tabVisits++
          return tab
        }
      })
    })
    session.tabsByWorktree['workspace-1'] = tabs
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation(
      (handle) => runtime.handles.get(handle)?.issuedForPaneKey ?? null
    )
    const journal = current.host.collaboratorsForTests().sessions.get(COORD)!.journal
    for (let index = 0; index < 9 * count; index++) {
      await journal.appendItem(
        { provider: 'orca', clientMessageId: `history-${index}` },
        {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: `History ${index}` }]
        },
        {
          fence: current.store.getConversation(COORD)!.currentFence,
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        }
      )
    }
    const admitted = await resolveOrchestrationSessionCaller(
      runtime,
      {
        id: 'scale',
        authToken: 'test-token',
        method: 'orchestration.workerStart',
        params: { spec: 'Task' },
        orchestrationCompatibilityEvidence: { agentSessionId: COORD }
      },
      undefined
    )
    let dispatchVisits = 0
    let taskVisits = 0
    installSqlVisitCounters({
      start_dispatch_visit: () => {
        dispatchVisits++
        return 1
      },
      start_task_visit: () => {
        taskVisits++
        return 1
      }
    })
    const prepareSource = db.db.prepare.bind(db.db)
    const sourceQueries = vi
      .spyOn(db.db, 'prepare')
      .mockImplementation((query) =>
        prepareSource(
          query
            .replace(
              'WHERE assignee_handle = ?',
              'WHERE assignee_handle = ? AND start_dispatch_visit(rowid)'
            )
            .replace(
              'FROM tasks WHERE id = ?',
              'FROM tasks WHERE id = ? AND start_task_visit(rowid)'
            )
        )
      )
    const connection = openTestJournalHostDatabase(current.root).db
    const epochReads = vi.spyOn(
      connection.prepare('SELECT epoch FROM journal_sessions WHERE session_id = ?'),
      'get'
    )
    const inserts = vi.spyOn(
      connection.prepare(
        'INSERT INTO journal_rows (session_id, epoch, seq, ts, row_json) VALUES (?, ?, ?, ?, ?)'
      ),
      'run'
    )
    const journalQueries = vi.spyOn(connection, 'prepare')
    const serialized = vi.spyOn(journalSchema, 'serializeJournalRow')
    const activeSource = vi.spyOn(db, 'getActiveDispatchForTerminal')
    const recordedSource = vi.spyOn(db, 'getDispatchContextById')
    const sender = vi.spyOn(runtime.orchestrationSenderNames, 'sender')
    const names = vi.spyOn(runtime.orchestrationSenderNames, 'nameOf')
    const dedupe = vi.spyOn(journal, 'hasRecordedItem')
    const scan = vi.spyOn(journal, 'visitItemsWithLinkage')
    const projection = StructuredAgentSessionJournalProjections.prototype
    const readProjection = projection.read
    let projecting = false
    vi.spyOn(projection, 'read').mockImplementation(function (
      this: StructuredAgentSessionJournalProjections,
      ...args
    ) {
      const previous = projecting
      projecting = true
      try {
        return readProjection.apply(this, args)
      } finally {
        projecting = previous
      }
    })
    const snapshotSources: string[] = []
    const readSnapshot = journal.snapshot.bind(journal)
    const snapshot = vi.spyOn(journal, 'snapshot').mockImplementation(() => {
      snapshotSources.push(projecting ? 'status-projection' : 'other')
      return readSnapshot()
    })
    const append = vi.spyOn(current.host, 'appendAgentStart')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const before = journal.snapshot()
    snapshot.mockClear()
    const fail = prepareWorkerStartCard(runtime, admitted.caller)
    expect(epochReads).toHaveBeenCalledTimes(1)
    inserts.mockImplementationOnce(() => {
      throw new Error('fixture insert failed')
    })
    fail(facts[0])
    await eventually(() => expect(append).toHaveBeenCalledTimes(1))
    await Promise.allSettled(append.mock.results.map((result) => result.value))
    await eventually(() =>
      expect(warn).toHaveBeenCalledWith(
        '[orchestration] recording a started worker in its caller chat failed',
        expect.any(Error)
      )
    )
    expect(epochReads).toHaveBeenCalledTimes(3)
    expect(serialized).toHaveBeenCalledTimes(1)
    expect(inserts).toHaveBeenCalledTimes(1)
    expect(sourceQueries).toHaveBeenCalledTimes(2)
    expect(dispatchVisits).toBe(1)
    expect(taskVisits).toBe(1)
    expect(tabVisits).toBe(9 * count + 1)
    expect(journal.snapshot()).toEqual(before)
    expect(
      connection
        .prepare('SELECT COUNT(*) AS count FROM journal_rows WHERE session_id = ?')
        .get(COORD)?.count
    ).toBe(before.cursor.sequence)
    for (const counter of [
      epochReads,
      serialized,
      inserts,
      sourceQueries,
      journalQueries,
      activeSource,
      recordedSource,
      sender,
      names,
      dedupe,
      scan,
      snapshot,
      append,
      warn
    ]) {
      counter.mockClear()
    }
    snapshotSources.length = 0
    tabVisits = dispatchVisits = taskVisits = 0
    const publishers = facts.map(() => prepareWorkerStartCard(runtime, admitted.caller))
    expect(epochReads).toHaveBeenCalledTimes(count)
    facts.forEach((fact, index) => publishers[index](fact))
    await eventually(() => expect(append).toHaveBeenCalledTimes(count))
    await Promise.all(append.mock.results.map((result) => result.value))
    expect(epochReads).toHaveBeenCalledTimes(3 * count)
    expect(serialized).toHaveBeenCalledTimes(count)
    expect(inserts).toHaveBeenCalledTimes(count)
    expect(snapshotSources).toEqual(['status-projection'])
    // Duplicate callbacks still name the sender but must stop before row serialization/insertion.
    facts.forEach((fact, index) => publishers[index](fact))
    await eventually(() => expect(append).toHaveBeenCalledTimes(2 * count))
    await Promise.all(append.mock.results.map((result) => result.value))
    expect(epochReads).toHaveBeenCalledTimes(5 * count)
    expect(serialized).toHaveBeenCalledTimes(count)
    expect(inserts).toHaveBeenCalledTimes(count)
    expect(sender).toHaveBeenCalledTimes(2 * count)
    expect(names).toHaveBeenCalledTimes(2 * count)
    expect(activeSource).toHaveBeenCalledTimes(2 * count)
    expect(recordedSource).not.toHaveBeenCalled()
    expect(sourceQueries).toHaveBeenCalledTimes(4 * count)
    expect(dispatchVisits).toBe(2 * count)
    expect(taskVisits).toBe(2 * count)
    const visitsPerPass = facts.reduce((sum, _fact, index) => sum + 9 * count + index + 1, 0)
    expect(tabVisits).toBe(2 * visitsPerPass)
    expect(tabVisits).toBeLessThanOrEqual(2 * count * tabs.length)
    expect(dedupe).toHaveBeenCalledTimes(2 * count)
    expect(scan).not.toHaveBeenCalled()
    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(snapshotSources).toEqual(['status-projection'])
    expect(journalQueries.mock.calls.filter(([query]) => /FROM journal_rows/.test(query))).toEqual(
      []
    )
    expect(warn).not.toHaveBeenCalled()
    for (const [query] of sourceQueries.mock.calls.slice(0, 2)) {
      const plan = prepareSource(`EXPLAIN QUERY PLAN ${query}`)
        .all('unused')
        .map((row) => row.detail)
        .join(' | ')
      expect(plan).toMatch(/SEARCH (?:dispatch_contexts|tasks)/)
      expect(plan).not.toMatch(/SCAN/)
    }
    const cards = journal.snapshot().items.filter(({ body }) => body.kind === 'agent-start')
    expect(cards.map(({ body }) => body)).toEqual(
      facts.map((fact) => ({
        kind: 'agent-start',
        dispatchId: fact.dispatchId,
        task: fact.task,
        worker: {
          party: {
            address: fact.workerAddress,
            terminalHandle: fact.workerAddress,
            orcaSessionId: null
          },
          name: fact.name
        }
      }))
    )
    expect(
      connection
        .prepare('SELECT COUNT(*) AS count FROM journal_rows WHERE session_id = ?')
        .get(COORD)?.count
    ).toBe(before.cursor.sequence + count)
    console.info('start population/operations', {
      count,
      sourceRecords: 10 * count,
      history: 9 * count,
      epochReads: epochReads.mock.calls.length,
      serializedRows: serialized.mock.calls.length,
      inserts: inserts.mock.calls.length,
      dispatchVisits,
      taskVisits,
      tabVisits
    })
  }
)
