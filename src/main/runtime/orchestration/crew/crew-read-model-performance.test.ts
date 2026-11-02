import { readCrewTraffic } from './crew-query'
import { readCrewParentInputs } from './crew-parent-inputs'

import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-ipc-payload'
import { RuntimeAgentOrchestrationProjection } from '../../runtime-agent-orchestration-projection'
import { readOrchestrationFleetAgentStatusSnapshot } from '../../orchestration-fleet-agent-status-snapshot'
import { RuntimeOrchestrationSenderNames } from '../../runtime-orchestration-sender-names'

import { afterEach, expect, it, vi } from 'vitest'

import { CrewReadModel } from './crew-read-model'
import { CrewChanges } from './crew-changes'
import { subscribeCrew } from './crew-stream'
import type { OrchestrationCrewFrame } from '../../../../shared/orchestration-crew'
import { agentSessionRecordFixture } from '../../../native-chat/agent-session-record-test-fixture'
import { agentSessionConversationView } from '../../../../shared/agent-session-conversation-view'

import { fixture } from './crew-read-model.test-fixture'
import { crewQueryPlans, meterCrewSql, sqlTotals } from './crew-recipient-sql.test-fixture'
afterEach(() => vi.useRealTimers())

it('shares complete host derivation across N/10N handled assignments and subscribers on real wakes', async () => {
  const flush = async () => {
    await Promise.resolve()
    await Promise.resolve()
  }
  const measure = async (population: number, subscribers: number) => {
    const { db, deps, assign, handles } = fixture()
    assign('term_worker')
    const unrelatedRun = db.createRun({
      objective: 'Other crews',
      coordinatorHandle: 'term_peer',
      coordinatorPaneKey: handles.get('term_peer')!
    })
    const records = Array.from({ length: population }, (_, i) =>
      agentSessionConversationView(agentSessionRecordFixture({ sessionId: `chat-scale-${i}` }))
    )
    for (const record of records) {
      db.createDispatchContext({
        taskId: db.createTask({ runId: unrelatedRun.id, spec: 'Unrelated' }).id,
        assigneeHandle: `term_handled_${record.sessionId}`,
        processIncarnation: `structured:${record.sessionId}`,
        creator: { kind: 'system' },
        maxDepth: 10
      })
    }
    const listRecords = vi.fn(() => records)
    deps.records = {
      listRecords,
      getRecord: (id) => records.find((record) => record.sessionId === id) ?? null
    }
    const resolvePane = vi.spyOn(deps, 'handleForPane')
    const meter = meterCrewSql(db.db)
    const dependencies = vi.fn(() => deps)
    const watch = vi.fn(db.crewChanges.subscribe)
    const model = new CrewReadModel(dependencies, watch)
    const publications = Array.from({ length: subscribers }, (): OrchestrationCrewFrame[] => [])
    const stops = publications.map((frames, i) =>
      subscribeCrew(
        () => model.read(i === 0 ? 'term_coord' : `orca_session_id:chat-empty-${i}`),
        model.subscribe,
        (frame) => frames.push(frame)
      )
    )
    await flush()
    expect(watch).toHaveBeenCalledTimes(1)
    expect(dependencies).toHaveBeenCalledTimes(1)
    expect(listRecords).toHaveBeenCalledTimes(1)
    expect(publications[0].filter((frame) => frame.type === 'rows')).toHaveLength(1)
    for (const frames of publications.slice(1)) {
      expect(frames).toEqual([{ type: 'begin', status: 'ok' }, { type: 'complete' }])
    }
    const initial = sqlTotals(meter.executions)
    meter.executions.length = 0
    listRecords.mockClear()
    resolvePane.mockClear()
    db.insertMessage({
      from: 'term_peer',
      to: 'term_outbound',
      subject: 'Unrelated update',
      body: 'Other crew traffic'
    })
    await flush()
    expect(dependencies).toHaveBeenCalledTimes(1)
    expect(listRecords).not.toHaveBeenCalled()
    // Traffic retains the immutable topology and never invokes the dependency helper.
    expect(sqlTotals(meter.executions).get).toBeLessThan(population + 10)
    expect(resolvePane.mock.calls.length).toBeLessThan(5 * population + 2 * subscribers + 10)
    for (const frames of publications) {
      expect(frames.filter((frame) => frame.type === 'complete')).toHaveLength(1)
    }
    const update = sqlTotals(meter.executions)
    for (const stop of stops) {
      stop()
    }
    const reads = dependencies.mock.calls.length
    db.insertMessage({ from: 'term_peer', to: 'term_outbound', subject: 'After teardown' })
    await flush()
    expect(dependencies).toHaveBeenCalledTimes(reads)
    meter.restore()
    resolvePane.mockRestore()
    return { initial, update }
  }
  const n = await measure(3, 3)
  const manyPanes = await measure(3, 30)
  const manyAssignments = await measure(30, 3)
  const tenN = await measure(30, 30)
  expect(manyPanes.update.get).toBe(n.update.get)
  expect(tenN.update.get).toBe(manyAssignments.update.get)
  for (const phase of ['initial', 'update'] as const) {
    for (const operation of ['all', 'get', 'iterate', 'rows', 'bytes'] as const) {
      expect(tenN[phase][operation]).toBeLessThanOrEqual(n[phase][operation] * 10)
    }
  }
})
it('counts the real status qualification/projection SQL on a decoration wake without global reacquisition', async () => {
  const now = 1_800_000_000_000
  vi.useFakeTimers({ now })
  const measurements: ReturnType<typeof sqlTotals>[] = []
  for (const population of [3, 30]) {
    const { db, deps, assign, handles } = fixture()
    assign('term_worker')
    const unrelated = db.createRun({
      objective: 'Unrelated',
      coordinatorHandle: 'term_peer',
      coordinatorPaneKey: handles.get('term_peer')!
    })
    for (let i = 0; i < population; i++) {
      const handle = `term_status_${i}`
      handles.set(handle, `tab_status_${i}:aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`)
      db.createDispatchContext({
        taskId: db.createTask({ runId: unrelated.id, spec: 'Other' }).id,
        assigneeHandle: handle,
        assigneePaneKey: handles.get(handle),
        creator: { kind: 'system' },
        maxDepth: 10
      })
    }
    const listRecords = vi.fn(() => [])
    deps.records = { listRecords, getRecord: () => null }
    const projection = new RuntimeAgentOrchestrationProjection({
      getDb: () => db,
      getLeaves: () => [],
      getPtys: () => [],
      paneOf: () => ({ tabId: null, paneKey: null, recordedAtGraphSequence: 0 }),
      issueLeafHandle: () => '',
      issuePtyHandle: () => '',
      makePaneKey: () => '',
      getWorktreeId: () => null,
      getHandleForPaneKey: deps.handleForPane,
      getPaneKey: deps.paneForHandle,
      getDispatchAuthority: () => null,
      getAgentStatusSnapshot: () => [],
      getSessionRecords: () => deps.records
    })
    const raw: AgentStatusIpcPayload[] = [...handles]
      .filter(([handle]) => handle === 'term_worker' || handle.startsWith('term_status_'))
      .map(([, paneKey]) => ({
        paneKey,
        state: 'working',
        agentType: 'codex',
        prompt: '',
        connectionId: null,
        receivedAt: now,
        stateStartedAt: now
      }))
    const acquireStatus = vi.fn(() =>
      readOrchestrationFleetAgentStatusSnapshot({
        getAgentStatusSnapshotFn: () => raw,
        readObservedAgentStatusPaneIdentityFn: () => ({ kind: 'unobserved' }),
        getAgentStatusTerminalHandleForPaneKey: (pane) => deps.handleForPane(pane) ?? undefined,
        getTerminalProcessIncarnation: () => 'test-process',
        getAgentStatusOrchestrationContextForPaneKey: (paneKey) =>
          projection.getForHandle(deps.handleForPane(paneKey)!, undefined, { paneKey })
      })
    )
    const title = 'First title'
    const names = new RuntimeOrchestrationSenderNames({
      getDb: () => db,
      getHandleRecord: (handle) =>
        handle === 'term_worker'
          ? { worktreeId: 'folder', tabId: 'tab_worker', ptyId: 'pty' }
          : undefined,
      getPtyAgents: () => ({ launchAgent: 'codex' }),
      getTerminalPaneKey: deps.paneForHandle,
      getWorkspaceSession: () => ({
        tabsByWorktree: { folder: [{ id: 'tab_worker', title, customTitle: null }] }
      }),
      getGeneratedTitlesEnabled: () => true,
      getAgentStatusSnapshot: () => raw,
      getAgentStatusSnapshotForPane: (pane) => raw.filter((row) => row.paneKey === pane),
      getTrackedTitle: () => null
    })
    const wake = new CrewChanges()
    const model = new CrewReadModel(
      () => ({
        ...deps,
        name: names.captureCrewInputs(),
        get statuses() {
          return acquireStatus()
        }
      }),
      wake.subscribe
    )
    const streams = Array.from({ length: population }, (_, i) =>
      subscribeCrew(
        () => model.read(i === 0 ? 'term_coord' : `orca_session_id:chat-empty-${i}`),
        model.subscribe,
        () => {}
      )
    )
    const globalSelection = vi.spyOn(db, 'listSessionDispatchesForPresentation')
    acquireStatus.mockClear()
    listRecords.mockClear()
    const meter = meterCrewSql(db.db)
    raw[0] = { ...raw[0], state: 'waiting' }
    wake.notify(new Set(['status']))
    await Promise.resolve()
    expect(acquireStatus).toHaveBeenCalledTimes(1)
    expect(globalSelection).not.toHaveBeenCalled()
    expect(listRecords).not.toHaveBeenCalled()
    const executed = sqlTotals(meter.executions)
    const sql = meter.executions.map((entry) => entry.sql)
    expect(executed.get).toBeGreaterThan(population * 2)
    expect(sql.some((text) => text.includes('attempt_observation_facts'))).toBe(true)
    expect(sql.some((text) => text.includes('retry_of_dispatch_id AS retry'))).toBe(false)
    expect(model.read('term_coord').sections.managing[0].status).toBe('waiting')
    measurements.push(executed)
    acquireStatus.mockClear()
    handles.delete('term_worker')
    wake.notify(new Set(['status']))
    await Promise.resolve()
    expect(acquireStatus).toHaveBeenCalledTimes(1)
    expect(globalSelection).toHaveBeenCalledTimes(1)
    for (const stop of streams) {
      stop()
    }
    meter.restore()
    globalSelection.mockRestore()
  }
  for (const key of ['get', 'all', 'iterate', 'rows'] as const) {
    expect(measurements[1][key]).toBeLessThanOrEqual(measurements[0][key] * 10)
  }
})
it('selects peer maxima without losing bodies and uses indexed historical provenance', () => {
  const { db, run, assign, handles } = fixture()
  handles.set('term_worker', 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
  assign('term_worker')
  db.insertMessage({
    runId: run.id,
    from: 'term_worker',
    to: 'term_coord',
    subject: 'Large losing body',
    body: 'x'.repeat(64 * 1024)
  })
  const winner = db.insertMessage({
    runId: run.id,
    from: 'term_worker',
    to: 'term_coord',
    subject: 'Winner',
    body: 'latest'
  })
  const meter = meterCrewSql(db.db)
  const traffic = readCrewTraffic(db, ['term_coord', `run:${run.id}`], '2000-01-01T00:00:00Z')
  expect(traffic).toMatchObject([
    { peer: 'term_worker', direction: 'from', sequence: winner.sequence, body: 'latest' }
  ])
  const provenance = readCrewParentInputs(db, ['term_worker'], [handles.get('term_worker')!])
  expect(provenance.claims.filter((row) => row.family === 'local')).toHaveLength(1)
  meter.restore()
  const plan = JSON.stringify(
    crewQueryPlans(
      db.db,
      meter.executions.filter((entry) => entry.method === 'all')
    ).plans.map((row) => row.plan)
  )
  expect(plan).toContain('idx_crew_dispatch_leaf')
  expect(plan).toContain('idx_crew_remote_leaf')
  expect(plan).toContain('idx_crew_resource_leaf')
  expect(plan).toContain('idx_messages_crew_from')
  expect(plan).toContain('idx_messages_crew_to')
  expect(plan).toContain('idx_crew_dispatch_pane')
  expect(plan).not.toContain('SCAN dispatch_contexts')
})

it('drives pending questions from metadata on real N/10N mailbox wakes', async () => {
  const receipts: {
    retainedMessages: number
    pending: number
    executions: number
    rows: number
    bytes: number
    plan: string[]
  }[] = []
  for (const retainedMessages of [100, 1000]) {
    const { db, deps, run, assign } = fixture()
    assign('term_worker')
    db.insertMessages(
      Array.from({ length: retainedMessages }, (_, i) => ({
        runId: run.id,
        from: 'term_worker',
        to: 'term_coord',
        subject: 'Ordinary mail',
        body: `mail-${i}`
      }))
    )
    const prepare = db.db.prepare.bind(db.db)
    const operations = { executions: 0, rows: 0, bytes: 0 }
    const plans: string[][] = []
    const spy = vi.spyOn(db.db, 'prepare').mockImplementation((sql) => {
      const statement = prepare(sql)
      if (!sql.includes('FROM question_threads q INDEXED BY idx_crew_pending_questions')) {
        return statement
      }
      return {
        all: (...args) => {
          operations.executions++
          const rows = statement.all(...args)
          operations.rows += rows.length
          operations.bytes += Buffer.byteLength(JSON.stringify(rows))
          plans.push(
            prepare(`EXPLAIN QUERY PLAN ${sql}`)
              .all(...args)
              .map((row) => String(row.detail))
          )
          return rows
        },
        get: (...args) => statement.get(...args),
        run: (...args) => statement.run(...args),
        iterate: (...args) => statement.iterate(...args),
        setReadBigInts: (value) => statement.setReadBigInts(value)
      }
    })
    const frames: OrchestrationCrewFrame[] = []
    const model = new CrewReadModel(() => deps, db.crewChanges.subscribe)
    const stop = subscribeCrew(
      () => model.read('term_coord'),
      model.subscribe,
      (frame) => frames.push(frame)
    )
    try {
      operations.executions = operations.rows = operations.bytes = 0
      plans.length = 0
      const publications = frames.filter((frame) => frame.type === 'complete').length
      db.insertMessage({
        from: 'term_peer',
        to: 'term_outbound',
        subject: 'Unrelated committed wake'
      })
      await Promise.resolve()
      await Promise.resolve()
      expect(operations).toEqual({ executions: 1, rows: 0, bytes: 2 })
      expect(frames.filter((frame) => frame.type === 'complete')).toHaveLength(publications)
      // This is actual executed query planning plus returned work, not native VM/visit accounting.
      expect(plans[0][0]).toContain('SCAN q USING INDEX idx_crew_pending_questions')
      expect(
        plans[0].some((detail) => detail.includes('SEARCH m') && detail.includes('(id=?)'))
      ).toBe(true)
      expect(plans[0].join(' ')).not.toContain('idx_inbox')
      receipts.push({ retainedMessages, pending: 0, ...operations, plan: plans[0] })
      stop()
      operations.executions = 0
      db.insertMessage({ from: 'term_peer', to: 'term_outbound', subject: 'After teardown' })
      await Promise.resolve()
      await Promise.resolve()
      expect(operations.executions).toBe(0)
    } finally {
      stop()
      spy.mockRestore()
    }
  }
  expect(receipts[1].executions).toBe(receipts[0].executions)
  expect(receipts[1].rows).toBe(receipts[0].rows)
  expect(receipts[1].bytes).toBe(receipts[0].bytes)
})
