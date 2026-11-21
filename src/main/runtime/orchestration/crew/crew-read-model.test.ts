import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status/contracts/agent-status-freshness'

import { describe, expect, it, vi } from 'vitest'

import { buildCrewSnapshot } from './crew-party-snapshot'
import { CREW_HOST_GRACE_MS, CrewReadModel } from './crew-read-model'
import { subscribeCrew } from './crew-stream'
import { agentSessionRecordFixture } from '../../../native-chat/testing/agent-session-record-test-fixture'
import { agentSessionConversationView } from '../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'

import { fixture } from './crew-read-model.test-fixture'

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
    const questionLatest = snapshot.sections.managing.find(
      (row) => row.sendAddress === `dispatch:${worker.id}`
    )!.latest
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
    const workerRow = snapshot.sections.managing.find(
      (row) => row.sendAddress === `dispatch:${worker.id}`
    )!
    expect(db.getDispatchContextById(helper.id)?.creator_dispatch_id).toBe(worker.id)
    const gate = db.createGate({ taskId: worker.task_id, question: 'Ship?' })
    db.resolveGate(gate.id, 'Yes')
    const reopened = buildCrewSnapshot('term_coord', deps).sections.managing.find(
      (row) => row.partyKey === workerRow.partyKey
    )
    expect(reopened?.task?.state).toBe('ready')
    expect(reopened).toMatchObject({
      partyKey: workerRow.partyKey,
      openTarget: workerRow.openTarget,
      latest: questionLatest,
      sendAddress: 'term_worker'
    })
    expect(reopened).not.toHaveProperty('pendingQuestion')
  })
})

it("keeps a worker's last real message over Orca's own records", () => {
  const { db, deps, assign } = fixture()
  const worker = assign('term_worker')
  db.insertMessage({
    from: 'term_worker',
    to: 'term_coord',
    subject: 'Update',
    body: 'Read 3 files'
  })
  // Orca's notice as QA recorded it, an agent's own escalation, an empty setup receipt and a rejected report.
  db.insertMessage({
    from: 'term_worker',
    to: 'term_coord',
    subject: 'Worker stopped without reporting',
    body: 'Worker term_698aff42-fca8-4378-b317-029b98be48dc ended its turn without sending worker_done for task "W4: list files then wait" (task_b7063456179a). The Dispatch is still open. Answer it with your Orca CLI\'s `orchestration send --to dispatch:ctx_e99c0e270caf --subject "<topic>" --body "<guidance>"`, retry it, or stop the worker.',
    type: 'escalation',
    priority: 'high'
  })
  db.insertMessage({
    from: 'term_worker',
    to: 'term_coord',
    subject: 'Blocked: no database credentials',
    body: 'I need credentials for the staging database.',
    type: 'escalation'
  })
  db.insertMessage({ from: `dispatch:${worker.id}`, to: 'term_coord', subject: 'Setup ready' })
  const report = db.insertMessage({
    from: 'term_worker',
    to: 'term_coord',
    subject: 'Done',
    body: 'Finished',
    type: 'worker_done'
  })
  db.convertLifecycleMessageToRejection(
    report.id,
    'payload_required',
    'worker_done requires a JSON object payload'
  )
  expect(buildCrewSnapshot('term_coord', deps).sections.managing[0]?.latest).toMatchObject({
    direction: 'from',
    preview: 'Read 3 files'
  })
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

it('rederives exact and backwards clocks and drops unwatched one-shot truth', () => {
  const { db, deps, assign } = fixture()
  const worker = assign('term_worker')
  db.completeDispatch(worker.id)
  const completed = Date.parse('2026-10-28T00:00:00Z')
  db.db
    .prepare('UPDATE dispatch_contexts SET completed_at = ? WHERE id = ?')
    .run(new Date(completed).toISOString(), worker.id)
  const clock = vi.spyOn(Date, 'now').mockReturnValue(completed)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
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
    vi.advanceTimersByTime(CREW_HOST_GRACE_MS)
    expect(model.read('term_coord').sections.managing).toHaveLength(1)
    db.db
      .prepare("UPDATE dispatch_contexts SET completed_at = '2000-01-01' WHERE id = ?")
      .run(worker.id)
    expect(model.read('term_coord').sections.managing).toHaveLength(0)
  } finally {
    vi.useRealTimers()
    clock.mockRestore()
  }
})

it('invalidates host membership when report import uses the transaction settlement entry point', async () => {
  const { db, deps, assign } = fixture()
  const worker = assign('term_worker')
  const model = new CrewReadModel(() => deps, db.crewChanges.subscribe)
  const stop = subscribeCrew(
    () => model.read('term_coord'),
    model.subscribe,
    () => {}
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
  expect(model.read('term_coord').sections.managing[0].task?.state).toBe('completed')
  stop()
})

it('shows what changed for a chat that left and one that is new while the host is kept', () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const { db, deps, run, assign, handles } = fixture()
  try {
    assign('term_worker')
    const other = db.createRun({
      objective: 'Other crew',
      coordinatorHandle: 'term_peer',
      coordinatorPaneKey: handles.get('term_peer')!
    })
    const model = new CrewReadModel(() => deps, db.crewChanges.subscribe)
    const show = (party: string) => {
      const stop = model.subscribe(() => {}, party)
      return { snapshot: model.read(party), stop }
    }
    show('term_coord').stop()
    // A worker for the other crew starts while the first crew's host is kept.
    const task = db.createTask({ runId: other.id, spec: 'Other work', taskTitle: 'Other work' })
    db.updateTaskStatus(task.id, 'ready')
    db.createDispatchContext({
      taskId: task.id,
      assigneeHandle: 'term_helper',
      assigneePaneKey: handles.get('term_helper'),
      creator: { kind: 'terminal', handle: 'term_peer', paneKey: handles.get('term_peer') },
      maxDepth: 10
    })
    const peer = show('term_peer')
    expect(peer.snapshot.sections.managing.map((row) => row.task?.title)).toEqual(['Other work'])
    // Mail to the first crew while only the other one is shown.
    db.insertMessage({
      runId: run.id,
      from: 'term_worker',
      to: 'term_coord',
      subject: 'Update',
      body: 'while away'
    })
    peer.stop()
    const back = show('term_coord')
    expect(back.snapshot.sections.managing.map((row) => row.latest?.preview)).toEqual([
      'while away'
    ])
    back.stop()
  } finally {
    vi.useRealTimers()
  }
})

it('reads fresh for a chat no kept host covers, without subscribing', () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const { db, deps, assign, handles } = fixture()
  try {
    assign('term_worker')
    const model = new CrewReadModel(() => deps, db.crewChanges.subscribe)
    const stop = model.subscribe(() => {}, 'term_coord')
    model.read('term_coord')
    stop()
    const other = db.createRun({
      objective: 'Other crew',
      coordinatorHandle: 'term_peer',
      coordinatorPaneKey: handles.get('term_peer')!
    })
    const task = db.createTask({ runId: other.id, spec: 'Other work', taskTitle: 'Other work' })
    db.updateTaskStatus(task.id, 'ready')
    db.createDispatchContext({
      taskId: task.id,
      assigneeHandle: 'term_helper',
      assigneePaneKey: handles.get('term_helper'),
      creator: { kind: 'terminal', handle: 'term_peer', paneKey: handles.get('term_peer') },
      maxDepth: 10
    })
    // As the worker approvals stream reads a hidden coordinator.
    expect(model.read('term_peer').sections.managing.map((row) => row.task?.title)).toEqual([
      'Other work'
    ])
    db.insertMessage({
      runId: other.id,
      from: 'term_helper',
      to: 'term_peer',
      subject: 'Update',
      body: 'later'
    })
    expect(model.read('term_peer').sections.managing.map((row) => row.latest?.preview)).toEqual([
      'later'
    ])
  } finally {
    vi.useRealTimers()
  }
})

it('shows a worker started for a chat that closed beside an open one when it reopens', () => {
  const { db, deps, assign, handles } = fixture()
  assign('term_worker')
  const other = db.createRun({
    objective: 'Other crew',
    coordinatorHandle: 'term_peer',
    coordinatorPaneKey: handles.get('term_peer')!
  })
  const start = (handle: string, title: string) => {
    const task = db.createTask({ runId: other.id, spec: title, taskTitle: title })
    db.updateTaskStatus(task.id, 'ready')
    db.createDispatchContext({
      taskId: task.id,
      assigneeHandle: handle,
      assigneePaneKey: handles.get(handle),
      creator: { kind: 'terminal', handle: 'term_peer', paneKey: handles.get('term_peer') },
      maxDepth: 10
    })
  }
  start('term_helper', 'Other work')
  const model = new CrewReadModel(() => deps, db.crewChanges.subscribe)
  const stopCoord = model.subscribe(() => {}, 'term_coord')
  model.read('term_coord')
  const firstPeer = model.subscribe(() => {}, 'term_peer')
  model.read('term_peer')
  firstPeer()
  start('term_outbound', 'More work')
  const stopPeer = model.subscribe(() => {}, 'term_peer')
  expect(
    model
      .read('term_peer')
      .sections.managing.map((row) => row.task?.title)
      .sort()
  ).toEqual(['More work', 'Other work'])
  stopPeer()
  stopCoord()
})
