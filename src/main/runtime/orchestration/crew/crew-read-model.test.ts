import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-freshness'

import { createCrewPartyRegistry } from './crew-parties'
import type { FleetAgentStatusEvidence } from '../../../../shared/orchestration-fleet-agent-status-evidence'
import { describe, expect, it, vi } from 'vitest'

import { buildCrewSnapshot, CrewReadModel } from './crew-read-model'
import { subscribeCrew } from './crew-stream'
import type { OrchestrationCrewFrame } from '../../../../shared/orchestration-crew'
import { agentSessionRecordFixture } from '../../../native-chat/agent-session-record-test-fixture'
import { agentSessionConversationView } from '../../../../shared/agent-session-conversation-view'

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
