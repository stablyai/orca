import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-freshness'

import { createCrewPartyRegistry } from './crew-parties'
import type { FleetAgentStatusEvidence } from '../../../../shared/orchestration-fleet-agent-status-evidence'
import { describe, expect, it, vi } from 'vitest'

import { buildCrewSnapshot, CrewReadModel } from './crew-read-model'
import { CrewChanges } from './crew-changes'
import { subscribeCrew } from './crew-stream'
import type { OrchestrationCrewFrame } from '../../../../shared/orchestration-crew'
import { agentSessionRecordFixture } from '../../../native-chat/agent-session-record-test-fixture'
import { agentSessionConversationView } from '../../../../shared/agent-session-conversation-view'

import { fixture } from './crew-read-model.test-fixture'
import { resolveOrcaSessionParty } from '../orchestration-party'
import { testOrcaSessionId } from '../../../../shared/orca-session-address-test-fixture'

describe('public crew read and stream', () => {
  it('derives direct roles and two-sided latest mail without consuming questions or leaking authority', async () => {
    const { db, deps, run, assign } = fixture()
    const worker = assign('term_worker')
    assign('orca_session_id:chat-root', 'term_coord', 'Chat task')
    const helper = assign('term_helper', 'term_worker', 'Help worker')
    assign('term_grandchild', 'term_helper', 'Help helper')
    const mail = db.insertMessage({
      runId: run.id,
      from: 'term_worker',
      to: 'term_coord',
      subject: 'Update',
      body: 'earlier'
    })
    const newest = db.insertMessage({
      runId: run.id,
      from: `run:${run.id}`,
      to: `dispatch:${worker.id}`,
      subject: 'Reply',
      body: 'latest'
    })
    db.insertMessage({ from: 'term_peer', to: 'term_coord', subject: 'Peer', body: 'inbound' })
    db.insertMessage({ from: 'term_coord', to: 'term_outbound', subject: 'Peer', body: 'outbound' })
    db.insertMessage({
      from: 'term_noise',
      to: 'term_coord',
      subject: 'heartbeat',
      type: 'heartbeat'
    })
    const asked = db.createQuestion({
      runId: run.id,
      dispatchId: worker.id,
      askerHandle: 'term_worker',
      question: 'Which option?'
    })
    const before = db.db.prepare('SELECT read FROM messages WHERE id = ?').get(mail.id)
    let snapshot = buildCrewSnapshot('term_coord', deps)
    expect(snapshot.sections.managing.map((row) => row.task?.title).sort()).toEqual([
      'Chat task',
      'Implement crew'
    ])
    expect(snapshot.sections.talkingWith.map((row) => row.latest?.direction).sort()).toEqual([
      'from',
      'to'
    ])
    expect(
      snapshot.sections.managing.find((row) => row.sendAddress === `dispatch:${worker.id}`)
        ?.pendingQuestion?.preview
    ).toBe('Which option?')
    expect(
      snapshot.sections.managing.find((row) => row.sendAddress === `dispatch:${worker.id}`)?.latest
        ?.sequence
    ).toBe(asked.message.sequence)
    expect(
      buildCrewSnapshot('term_worker', deps).sections.managing.map((row) => row.sendAddress)
    ).toEqual([`dispatch:${helper.id}`])
    expect(db.db.prepare('SELECT read FROM messages WHERE id = ?').get(mail.id)).toEqual(before)
    expect(JSON.stringify(snapshot)).not.toMatch(
      /structworker_|capability|paneKey|process_incarnation|launch_token/
    )
    db.answerQuestion({
      messageId: asked.message.id,
      runId: run.id,
      body: 'Use B',
      consumerGeneration: run.consumer_generation
    })
    snapshot = buildCrewSnapshot('term_coord', deps)
    expect(snapshot.sections.managing.some((row) => row.pendingQuestion)).toBe(false)
    expect(
      snapshot.sections.managing.find((row) => row.sendAddress === `dispatch:${worker.id}`)?.latest
        ?.direction
    ).toBe('to')
    expect(newest.sequence).toBeGreaterThan(mail.sequence)
    const gate = db.createGate({ taskId: worker.task_id, question: 'Ship?' })
    db.resolveGate(gate.id, 'Yes')
    expect(
      buildCrewSnapshot('term_coord', deps).sections.managing.find(
        (row) => row.sendAddress === `dispatch:${worker.id}`
      )?.task?.state
    ).toBe('ready')
  })

  it('keeps an empty subscription awake for first creation, coalesces changes and resolves cleared chat roots', async () => {
    const { db, deps, assign } = fixture()
    const wake = new CrewChanges()
    deps.db = null
    deps.retainedDbExists = false
    const frames: OrchestrationCrewFrame[] = []
    const stop = subscribeCrew(
      () => buildCrewSnapshot('term_coord', deps),
      wake.subscribe,
      (frame) => frames.push(frame)
    )
    expect(frames).toEqual([{ type: 'begin', status: 'ok' }, { type: 'complete' }])
    deps.retainedDbExists = true
    expect(buildCrewSnapshot('term_coord', deps).status).toBe('unknown')
    deps.db = db
    const unwatchDb = db.crewChanges.subscribe(wake.notify)
    assign('term_worker')
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(frames.filter((frame) => frame.type === 'complete')).toHaveLength(2)
    expect(frames.find((frame) => frame.type === 'rows')).toMatchObject({ section: 'managing' })
    wake.notify()
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(frames.filter((frame) => frame.type === 'complete')).toHaveLength(2)
    stop()
    unwatchDb()
    const count = frames.length
    wake.notify()
    await Promise.resolve()
    expect(frames).toHaveLength(count)
    const root = agentSessionConversationView(
      agentSessionRecordFixture({
        sessionId: 'chat-root',
        conversationCommand: {
          command: 'clear',
          state: 'completed',
          callerKey: 'crew-fixture-clear',
          phase: 'committed',
          replacementSessionId: 'chat-next',
          operationId: 'clear-one'
        }
      })
    )
    const next = agentSessionConversationView(
      agentSessionRecordFixture({
        sessionId: 'chat-next',
        conversationName: 'Renamed',
        location: { workspaceId: 'folder-custom' }
      })
    )
    deps.records = {
      listRecords: () => [root, next],
      getRecord: (id) => (id === root.sessionId ? root : id === next.sessionId ? next : null)
    }
    assign('orca_session_id:chat-root')
    const chat = buildCrewSnapshot('orca_session_id:chat-next', deps)
    expect(chat.status).toBe('ok')
    expect(chat.sections.managedBy).toHaveLength(1)
    const child = buildCrewSnapshot('term_coord', deps).sections.managing.find(
      (row) => row.openTarget?.kind === 'chat'
    )
    expect(child?.openTarget).toEqual({
      kind: 'chat',
      sessionId: 'chat-next',
      worktreeId: 'folder-custom'
    })
  })
})

it('batches crew work as relationships scale and keeps skewed peers despite unrelated retained history', async () => {
  const { db, deps, run, assign } = fixture()
  for (let i = 0; i < 3; i++) {
    assign(`term_extra_${i}`)
  }
  const operations = { all: 0, get: 0, iterate: 0, rows: 0, bytes: 0 }
  const prepare = db.db.prepare.bind(db.db)
  const querySpy = vi.spyOn(db.db, 'prepare').mockImplementation((sql) => {
    const statement = prepare(sql)
    return {
      all: (...args) => {
        operations.all++
        const rows = statement.all(...args)
        operations.rows += rows.length
        operations.bytes += Buffer.byteLength(JSON.stringify(rows))
        return rows
      },
      get: (...args) => {
        operations.get++
        const row = statement.get(...args)
        operations.rows += row ? 1 : 0
        operations.bytes += Buffer.byteLength(JSON.stringify(row ?? null))
        return row
      },
      run: (...args) => statement.run(...args),
      iterate: function* (...args) {
        operations.iterate++
        for (const row of statement.iterate(...args)) {
          operations.rows++
          operations.bytes += Buffer.byteLength(JSON.stringify(row))
          yield row
        }
      },
      setReadBigInts: (value) => statement.setReadBigInts(value)
    }
  })
  buildCrewSnapshot('term_coord', deps)
  const small = { ...operations }
  const frames: OrchestrationCrewFrame[] = []
  const stop = subscribeCrew(
    () => buildCrewSnapshot('term_coord', deps),
    db.crewChanges.subscribe,
    (frame) => frames.push(frame)
  )
  for (let i = 0; i < 100; i++) {
    const old = assign(`term_retained_${i}`)
    db.completeDispatch(old.id)
    db.db
      .prepare("UPDATE dispatch_contexts SET completed_at = '2000-01-01T00:00:00Z' WHERE id = ?")
      .run(old.id)
  }
  await new Promise<void>((resolve) => queueMicrotask(resolve))
  await new Promise<void>((resolve) => queueMicrotask(resolve))
  expect(frames.filter((frame) => frame.type === 'complete')).toHaveLength(1)
  operations.all = operations.get = operations.iterate = operations.rows = operations.bytes = 0
  buildCrewSnapshot('term_coord', deps)
  expect(operations).toEqual(small)
  for (let i = 3; i < 30; i++) {
    assign(`term_extra_${i}`)
  }
  operations.all = operations.get = operations.iterate = operations.rows = operations.bytes = 0
  const large = buildCrewSnapshot('term_coord', deps)
  expect(large.sections.managing).toHaveLength(30)
  expect(operations.all).toBe(small.all)
  expect(operations.get).toBe(small.get)
  expect(operations.rows).toBeLessThanOrEqual(small.rows * 10)
  querySpy.mockRestore()
  for (let i = 0; i < 100; i++) {
    db.insertMessage({
      from: `run:${run.id}`,
      to: `term_mail_peer_${i}`,
      subject: 'Outbound only',
      body: String(i)
    })
  }
  const latest = db.insertMessage({
    from: 'term_mail_peer_0',
    to: 'term_coord',
    subject: 'Inbound',
    body: 'highest sequence across aliases'
  })
  const skewed = buildCrewSnapshot('term_coord', deps)
  expect(skewed.sections.talkingWith).toHaveLength(100)
  expect(
    skewed.sections.talkingWith.find((row) => row.latest?.preview === latest.body)?.latest
  ).toMatchObject({ sequence: latest.sequence, direction: 'from' })
  stop()
  vi.restoreAllMocks()
})

it('preserves a bound offline manager and the complete committed clear conversation', () => {
  const { db, deps, run, handles } = fixture()
  db.createDispatchContext({
    taskId: db.createTask({ runId: run.id, spec: 'System worker' }).id,
    assigneeHandle: 'term_worker',
    assigneePaneKey: handles.get('term_worker'),
    creator: { kind: 'system' },
    maxDepth: 10
  })
  handles.delete('term_coord')
  const manager = buildCrewSnapshot('term_worker', deps).sections.managedBy
  expect(manager).toHaveLength(1)
  expect(manager[0].sendAddress).toBe(`run:${run.id}`)
  expect(manager[0].openTarget).toBeUndefined()
  const record = (sessionId: string, next?: string) =>
    agentSessionConversationView(
      agentSessionRecordFixture({
        sessionId,
        ...(next
          ? {
              conversationCommand: {
                command: 'clear',
                state: 'completed',
                callerKey: 'crew-fixture-clear',
                phase: 'committed',
                replacementSessionId: next,
                operationId: `clear-${sessionId}`
              }
            }
          : {})
      })
    )
  const records = [
    record('chat-aaa', 'chat-bbb'),
    record('chat-bbb', 'chat-ccc'),
    record('chat-ccc')
  ]
  deps.records = {
    listRecords: () => records,
    getRecord: (id) => records.find((entry) => entry.sessionId === id) ?? null
  }
  db.insertMessage({
    from: 'orca_session_id:chat-aaa',
    to: 'term_peer',
    subject: 'Root',
    body: 'root'
  })
  const latest = db.insertMessage({
    from: 'term_peer',
    to: 'orca_session_id:chat-bbb',
    subject: 'Intermediate',
    body: 'intermediate'
  })
  const peers = buildCrewSnapshot('orca_session_id:chat-ccc', deps).sections.talkingWith
  expect(peers).toHaveLength(1)
  expect(peers[0].latest).toMatchObject({
    preview: 'intermediate',
    sequence: latest.sequence,
    direction: 'from'
  })
})

it('decorates handed-back peer questions after row creation without flattening direct children', () => {
  const { db, deps, run, assign } = fixture()
  const parent = assign('term_worker')
  const helper = assign('term_helper', 'term_worker')
  const question = db.createQuestion({
    runId: run.id,
    dispatchId: helper.id,
    askerHandle: 'term_helper',
    to: `dispatch:${parent.id}`,
    question: 'Choose the helper option?'
  })
  db.completeDispatch(parent.id)
  expect(db.getMessageById(question.message.id)?.to_handle).toBe(`run:${run.id}`)
  const snapshot = buildCrewSnapshot('term_coord', deps)
  expect(snapshot.sections.managing.map((row) => row.sendAddress)).toEqual([
    `dispatch:${parent.id}`
  ])
  expect(snapshot.sections.talkingWith).toHaveLength(1)
  expect(snapshot.sections.talkingWith[0].pendingQuestion?.preview).toBe(
    'Choose the helper option?'
  )
  expect(db.getQuestion(question.message.id)?.status).toBe('pending')
})

it('uses qualified terminal status and keeps canonical native status without requiring a terminal binding', () => {
  const { deps, assign, handles } = fixture()
  const worker = assign('term_worker')
  const now = Date.now()
  deps.now = now
  const status = {
    binding: {
      kind: 'worker',
      dispatchId: worker.id,
      paneKey: handles.get('term_worker')!,
      terminalHandle: 'term_worker',
      processIncarnation: 'incarnation'
    },
    clock: { kind: 'observed', at: now },
    deliveredAt: now,
    activity: {
      paneKey: handles.get('term_worker')!,
      connectionId: null,
      state: 'done',
      agentType: 'codex',
      model: null,
      worktreeId: null,
      restoredUnconfirmed: false,
      providerSessionOnly: false
    }
  } satisfies FleetAgentStatusEvidence
  const read = () =>
    buildCrewSnapshot('term_coord', deps).sections.managing.find(
      (row) => row.sendAddress === `dispatch:${worker.id}`
    )
  for (const invalid of [
    { ...status, binding: { kind: 'unresolved', reason: 'stale_incarnation' } },
    { ...status, binding: { ...status.binding, kind: 'worker', dispatchId: 'ctx_other' } },
    { ...status, activity: { ...status.activity, restoredUnconfirmed: true } },
    { ...status, activity: { ...status.activity, providerSessionOnly: true } },
    { ...status, clock: { kind: 'observed', at: now + 60_000 } },
    { ...status, clock: { kind: 'observed', at: now - 31 * 60_000 } }
  ] satisfies FleetAgentStatusEvidence[]) {
    deps.statuses = [invalid]
    expect(read()?.status).toBe('working')
    expect(read()?.agentKind).toBe('Agent')
  }
  deps.statuses = [status]
  expect(read()?.status).toBe('done')
  const native = agentSessionConversationView(
    agentSessionRecordFixture({ sessionId: 'chat-native' })
  )
  deps.records = {
    listRecords: () => [native],
    getRecord: (id) => (id === native.sessionId ? native : null)
  }
  assign('orca_session_id:chat-native')
  const nativeRow = buildCrewSnapshot('term_coord', deps).sections.managing.find(
    (row) => row.openTarget?.kind === 'chat'
  )!
  const registry = createCrewPartyRegistry(deps)
  const paneKey = registry.party('chat-native', null, null)!.paneKey!
  deps.statuses = [
    {
      ...status,
      binding: { kind: 'unresolved', reason: 'pane_not_bound' },
      activity: { ...status.activity, paneKey, state: 'waiting' }
    }
  ]
  expect(
    buildCrewSnapshot('term_coord', deps).sections.managing.find(
      (row) => row.partyKey === nativeRow.partyKey
    )?.status
  ).toBe('waiting')
})

it('hydrates expired peer provenance identically in reversed read orders without mutating shared inputs', () => {
  const { db, deps, run, handles } = fixture()
  handles.set('term_old', 'tab_old:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
  const record = agentSessionConversationView(
    agentSessionRecordFixture({ sessionId: 'chat-history' })
  )
  deps.records = {
    listRecords: () => [record],
    getRecord: (id) => (id === record.sessionId ? record : null)
  }
  const dispatch = db.createDispatchContext({
    taskId: db.createTask({ runId: run.id, spec: 'Old' }).id,
    assigneeHandle: 'term_old',
    processIncarnation: 'structured:chat-history',
    creator: { kind: 'system' },
    maxDepth: 10
  })
  db.completeDispatch(dispatch.id)
  db.db
    .prepare("UPDATE dispatch_contexts SET completed_at = '2000-01-01' WHERE id = ?")
    .run(dispatch.id)
  db.insertMessage({ from: 'term_old', to: 'term_peer', subject: 'Recent', body: 'retained alias' })
  const model = new CrewReadModel(() => deps, db.crewChanges.subscribe)
  const stop = model.subscribe(() => {})
  const fresh = buildCrewSnapshot('term_peer', deps)
  const before = model.read('term_peer')
  expect(before).toEqual(fresh)
  expect(() =>
    resolveOrcaSessionParty(testOrcaSessionId('chat-history'), db, deps.records)
  ).toThrow('worker identity')
  expect(before.sections.talkingWith[0]).not.toHaveProperty('sendAddress')
  expect(before.sections.talkingWith[0]).toMatchObject({
    openTarget: { kind: 'chat', sessionId: 'chat-history' },
    latest: { preview: 'retained alias' }
  })
  model.read('orca_session_id:chat-history')
  expect(model.read('term_peer')).toEqual(before)
  stop()
  const stopAgain = model.subscribe(() => {})
  model.read('orca_session_id:chat-history')
  expect(model.read('term_peer')).toEqual(before)
  stopAgain()
})

it('keeps corrupt clear branches, missing successors and cycles independent of record order', () => {
  const { deps } = fixture()
  const record = (sessionId: string, next: string) =>
    agentSessionConversationView(
      agentSessionRecordFixture({
        sessionId,
        conversationCommand: {
          command: 'clear',
          state: 'completed',
          callerKey: 'crew-fixture-clear',
          phase: 'committed',
          replacementSessionId: next,
          operationId: sessionId
        }
      })
    )
  const rows = [
    record('chat-aaa', 'chat-ccc'),
    record('chat-bbb', 'chat-ccc'),
    record('chat-ccc', 'chat-ddd'),
    record('chat-xxx', 'chat-yyy'),
    record('chat-yyy', 'chat-xxx')
  ]
  const identities = (records: typeof rows) => {
    const registry = createCrewPartyRegistry({
      ...deps,
      records: { listRecords: () => records, getRecord: () => null }
    })
    return rows.map((row) => registry.party(row.sessionId, null, null)?.address)
  }
  expect(identities(rows)).toEqual(rows.map((row) => `orca_session_id:${row.sessionId}`))
  expect(identities(rows.toReversed())).toEqual(identities(rows))
  const invalid = [record('!invalid', 'chat-valid'), record('chat-valid', '')]
  for (const records of [invalid, invalid.toReversed()]) {
    expect(() => identities(records)).toThrow('Not an Orca session id: !invalid')
  }
})

it('wakes for later routing pages and existing-message question registration, including rollback', async () => {
  const { db, deps, run, assign } = fixture()
  const worker = assign('term_worker')
  const model = new CrewReadModel(() => deps, db.crewChanges.subscribe)
  const frames: OrchestrationCrewFrame[] = []
  const stop = subscribeCrew(
    () => model.read('term_coord'),
    model.subscribe,
    (frame) => frames.push(frame)
  )
  const messages = db.insertMessages(
    Array.from({ length: 51 }, (_, i) => ({
      runId: run.id,
      from: `dispatch:${worker.id}`,
      to: 'term_unowned',
      subject: 'Routed',
      body: `page-${i}`
    }))
  )
  await Promise.resolve()
  expect(db.routeDirectMessagePage(`run:${run.id}`, run.id, 'term_unowned').hasMore).toBe(true)
  await Promise.resolve()
  expect(model.read('term_coord').sections.managing[0].latest?.preview).toBe('page-49')
  db.routeDirectMessagePage(`run:${run.id}`, run.id, 'term_unowned')
  await Promise.resolve()
  expect(model.read('term_coord').sections.managing[0].latest?.preview).toBe('page-50')
  const existing = db.insertMessage({
    runId: run.id,
    from: `dispatch:${worker.id}`,
    to: `run:${run.id}`,
    subject: 'Question already imported',
    type: 'question',
    body: 'Existing metadata'
  })
  await Promise.resolve()
  expect(model.read('term_coord').sections.managing[0].pendingQuestion).toBeUndefined()
  db.registerFederatedQuestion({ messageId: existing.id, runId: run.id, dispatchId: worker.id })
  await Promise.resolve()
  expect(model.read('term_coord').sections.managing[0].pendingQuestion?.preview).toBe(
    'Existing metadata'
  )
  const count = frames.filter((frame) => frame.type === 'complete').length
  db.db.exec('BEGIN')
  db.insertMessage({
    from: 'term_peer',
    to: 'term_coord',
    subject: 'Rolled back',
    body: 'never visible'
  })
  db.db.exec('ROLLBACK')
  await Promise.resolve()
  expect(frames.filter((frame) => frame.type === 'complete')).toHaveLength(count)
  expect(db.getMessageById(messages[50].id)?.to_handle).toBe(`run:${run.id}`)
  stop()
})

it('rederives exact and backwards clocks and drops unwatched one-shot truth', () => {
  const { db, deps, assign } = fixture()
  const worker = assign('term_worker')
  db.completeDispatch(worker.id)
  const completed = Date.parse('2026-10-28T00:00:00Z')
  db.db
    .prepare('UPDATE dispatch_contexts SET completed_at = ? WHERE id = ?')
    .run(new Date(completed).toISOString(), worker.id)
  const clock = vi.spyOn(Date, 'now').mockReturnValue(completed)
  try {
    const model = new CrewReadModel(() => deps, db.crewChanges.subscribe)
    const stop = model.subscribe(() => {})
    expect(model.read('term_coord').sections.managing).toHaveLength(1)
    clock.mockReturnValue(completed + AGENT_STATUS_STALE_AFTER_MS)
    expect(model.read('term_coord').sections.managing).toHaveLength(1)
    clock.mockReturnValue(completed + AGENT_STATUS_STALE_AFTER_MS + 1)
    expect(model.read('term_coord').sections.managing).toHaveLength(0)
    clock.mockReturnValue(completed)
    expect(model.read('term_coord').sections.managing).toHaveLength(1)
    stop()
    expect(model.read('term_coord').sections.managing).toHaveLength(1)
    db.db
      .prepare("UPDATE dispatch_contexts SET completed_at = '2000-01-01' WHERE id = ?")
      .run(worker.id)
    expect(model.read('term_coord').sections.managing).toHaveLength(0)
  } finally {
    clock.mockRestore()
  }
})

it('retains reentrant invalidations and discards a generation whose acquisition fails', async () => {
  const { deps, assign } = fixture()
  assign('term_worker')
  const wake = new CrewChanges()
  let fail = false
  let reenter = false
  let reads = 0
  const model = new CrewReadModel(() => {
    reads++
    if (fail) {
      throw new Error('source unavailable')
    }
    if (reenter) {
      reenter = false
      wake.notify(new Set(['records']))
    }
    return deps
  }, wake.subscribe)
  const stop = model.subscribe(() => {})
  expect(model.read('term_coord').sections.managing).toHaveLength(1)
  reenter = true
  wake.notify()
  model.read('term_coord')
  model.read('term_coord')
  expect(reads).toBe(3)
  fail = true
  wake.notify(new Set(['status']))
  expect(() => model.read('term_coord')).toThrow('source unavailable')
  fail = false
  // The next legitimate event must reacquire, even when it only changes traffic.
  wake.notify(new Set(['traffic']))
  expect(model.read('term_coord').sections.managing).toHaveLength(1)
  expect(reads).toBe(5)
  stop()
})

it('invalidates host membership when report import uses the transaction settlement entry point', async () => {
  const { db, deps, assign } = fixture()
  const worker = assign('term_worker')
  const model = new CrewReadModel(() => deps, db.crewChanges.subscribe)
  const frames: OrchestrationCrewFrame[] = []
  const stop = subscribeCrew(
    () => model.read('term_coord'),
    model.subscribe,
    (frame) => frames.push(frame)
  )
  expect(model.read('term_coord').sections.managing[0].task?.state).toBe('dispatched')
  db.db.exec('BEGIN')
  const result = db.settleWorkerReportInTransaction({
    taskId: worker.task_id,
    dispatchId: worker.id,
    outcome: 'succeeded',
    result: 'Completed remotely'
  })
  db.db.exec('COMMIT')
  await Promise.resolve()
  expect(result.action).toBe('settled')
  expect(db.getDispatchContextById(worker.id)?.completed_at).toBeTruthy()
  expect(model.read('term_coord').sections.managing[0].task?.state).toBe('completed')
  expect(frames.filter((frame) => frame.type === 'complete')).toHaveLength(2)
  stop()
})
