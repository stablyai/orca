import {
  expectWorkerStartPopulation,
  expectWorkerStartSourcePlans
} from './worker-start-card-population.test-fixture'
import { expect, it, vi } from 'vitest'
import { partialRuntimeStore } from '../../../runtime-store-partial-fixture'
import { resolveOrchestrationSessionCaller } from '../../orchestration-session-caller'
import { setStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  createQueuedMessageTestRig,
  eventually
} from '../../../../native-chat/agent-session-wire/structured-agent-session-queued-message-rig.test-fixture'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session-journal-types'
import { openTestJournalHostDatabase } from '../../../../native-chat/agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionJournalProjections } from '../../../../native-chat/agent-session-wire/structured-agent-session-status-journal-projection'
import { installSqlVisitCounters } from '../../../dispatch-predicate-visits.test-fixture'
import { createMinimalPersistedTerminalTab } from '../../../../persistence/restoring-sessions/session-owner-fields'
import { getDefaultWorkspaceSession } from '../../../../../shared/constants'
import { prepareWorkerStartCard } from '../../../orchestration/worker-start-card'
import * as journalSchema from '../../../../native-chat/agent-session-journal/journal-row-schema'

import { fixture, COORD, h } from './worker-start-card-contract-test-fixture'

it.each([10, 100])(
  'counts populated producer source and journal operations for %i starts and duplicate publications',
  async (count) => {
    fixture.rig = await createQueuedMessageTestRig({ sessionId: COORD, legacyInputs: true })
    const current = fixture.rig
    setStructuredAgentSessionHost(current.host)
    const session = getDefaultWorkspaceSession()
    const { runtime, db } = h.setup(
      false,
      partialRuntimeStore({
        getSettings: () => ({ agentDefaultSurface: 'terminal' }),
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
    expect(epochReads).toHaveBeenCalledTimes(4)
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
    expect(epochReads).toHaveBeenCalledTimes(4 * count)
    expect(serialized).toHaveBeenCalledTimes(count)
    expect(inserts).toHaveBeenCalledTimes(count)
    expect(snapshotSources).toEqual(['status-projection'])
    // Duplicate callbacks still name the sender but must stop before row serialization/insertion.
    facts.forEach((fact, index) => publishers[index](fact))
    await eventually(() => expect(append).toHaveBeenCalledTimes(2 * count))
    await Promise.all(append.mock.results.map((result) => result.value))
    expect(epochReads).toHaveBeenCalledTimes(6 * count)
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
    expect(
      journalQueries.mock.calls.filter(
        ([query]) => /FROM journal_rows/.test(query) && !/seq = 1/.test(query)
      )
    ).toEqual([])
    expect(warn).not.toHaveBeenCalled()
    expectWorkerStartSourcePlans(sourceQueries.mock.calls, prepareSource)
    expectWorkerStartPopulation({ journal, facts, count, connection, before })
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
