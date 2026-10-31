import { expect, it, vi } from 'vitest'
import { fixture } from './crew-read-model.test-fixture'
import { buildCrewSnapshot, CrewReadModel } from './crew-read-model'
import { subscribeCrew } from './crew-stream'
import type { OrchestrationCrewFrame } from '../../../../shared/orchestration-crew'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-freshness'
import { agentSessionRecordFixture } from '../../../native-chat/agent-session-record-test-fixture'
import { agentSessionConversationView } from '../../../../shared/agent-session-conversation-view'
import { testOrcaSessionId } from '../../../../shared/orca-session-address-test-fixture'

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
  expect(snapshot.sections.managing.map((row) => row.sendAddress)).toEqual(['term_worker'])
  expect(snapshot.sections.talkingWith).toHaveLength(1)
  expect(snapshot.sections.talkingWith[0].pendingQuestion?.preview).toBe(
    'Choose the helper option?'
  )
  expect(db.getQuestion(question.message.id)?.status).toBe('pending')
})

it('keeps aged read handbacks independently pending through answer, close, audience loss and reacquisition', async () => {
  const f = fixture()
  const parent = f.assign('term_worker')
  const helper = f.assign('term_helper', 'term_worker')
  const other = f.assign('term_outbound', 'term_worker')
  const ask = (dispatchId: string, askerHandle: string, question: string, to?: string) =>
    f.db.createQuestion({ runId: f.run.id, dispatchId, askerHandle, question, to })
  const first = ask(helper.id, 'term_helper', 'oldest handback', `dispatch:${parent.id}`)
  const newest = ask(helper.id, 'term_helper', 'newest handback', `dispatch:${parent.id}`)
  const direct = ask(other.id, 'term_outbound', 'direct owned Run')
  f.db.markAsReadAndDelivered([first.message.id, newest.message.id])
  f.db.completeDispatch(parent.id)
  for (const message of [first.message, newest.message]) {
    expect(f.db.getMessageById(message.id)).toMatchObject({ to_handle: `run:${f.run.id}`, read: 0 })
  }
  f.db.markAsReadAndDelivered([first.message.id, newest.message.id])
  const completedAt = f.db.getDispatchContextById(parent.id)?.completed_at
  expect(completedAt).toBeTruthy()
  if (!completedAt) {
    throw new Error('parent completion timestamp missing')
  }
  const lifecycleTimes = [
    completedAt,
    first.message.created_at,
    newest.message.created_at,
    direct.message.created_at
  ].map((value) => Date.parse(value))
  expect(lifecycleTimes.every(Number.isFinite)).toBe(true)
  const now = Math.max(...lifecycleTimes) + AGENT_STATUS_STALE_AFTER_MS + 1
  process.stdout.write(
    `C2 aged handback clock ${JSON.stringify({ completedAt, messageTimes: [first.message.created_at, newest.message.created_at, direct.message.created_at], lifecycleTimes, now, cutoff: now - AGENT_STATUS_STALE_AFTER_MS })}\n`
  )
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  const frames: OrchestrationCrewFrame[] = []
  const model = new CrewReadModel(() => f.deps, f.db.crewChanges.subscribe)
  let current = model.read('term_coord')
  let stop = subscribeCrew(
    () => {
      current = model.read('term_coord')
      return current
    },
    model.subscribe,
    (frame) => frames.push(frame)
  )
  const helperRow = () =>
    current.sections.talkingWith.find((row) => row.partyKey.endsWith('term_helper"]'))
  try {
    expect(f.db.getMessageById(newest.message.id)).toMatchObject({
      to_handle: `run:${f.run.id}`,
      read: 1
    })
    expect(current.sections.managing).toEqual([])
    expect(current.sections.talkingWith.map((row) => row.pendingQuestion?.preview)).toEqual([
      'direct owned Run',
      'newest handback'
    ])
    expect(helperRow()).toMatchObject({
      role: 'peer',
      pendingQuestion: { preview: 'newest handback' },
      openTarget: { kind: 'terminal', handle: 'term_helper' }
    })
    expect(helperRow()).not.toHaveProperty('latest')
    expect(
      current.sections.talkingWith.filter((row) => row.partyKey.endsWith('term_helper"]'))
    ).toHaveLength(1)
    expect(f.db.getMessageById(first.message.id)?.read).toBe(1)
    const count = () => frames.filter((frame) => frame.type === 'complete').length
    const unchanged = count()
    f.db.markAsReadAndDelivered([newest.message.id])
    await Promise.resolve()
    expect(count()).toBe(unchanged)
    f.db.answerQuestion({
      messageId: newest.message.id,
      runId: f.run.id,
      consumerGeneration: f.run.consumer_generation,
      body: 'answer latest'
    })
    await Promise.resolve()
    expect(helperRow()?.pendingQuestion?.preview).toBe('oldest handback')
    expect(helperRow()).not.toHaveProperty('latest')
    f.db.closeQuestionsForDispatch(helper.id)
    await Promise.resolve()
    expect(helperRow()).toBeUndefined()
    expect(
      current.sections.talkingWith.find((row) => row.pendingQuestion)?.pendingQuestion?.preview
    ).toBe('direct owned Run')
    // Production routing moves the current audience away; pending metadata remains alive.
    f.db.routeDirectMessagePage('term_elsewhere', f.run.id, `run:${f.run.id}`)
    await Promise.resolve()
    expect(current.sections.talkingWith.some((row) => row.pendingQuestion)).toBe(false)
    expect(f.db.getQuestion(direct.message.id)?.status).toBe('pending')
    stop()
    f.db.routeDirectMessagePage(`run:${f.run.id}`, f.run.id, 'term_elsewhere')
    stop = subscribeCrew(
      () => {
        current = model.read('term_coord')
        return current
      },
      model.subscribe,
      (frame) => frames.push(frame)
    )
    expect(
      current.sections.talkingWith.find((row) => row.pendingQuestion)?.pendingQuestion?.preview
    ).toBe('direct owned Run')
    f.db.closeQuestionsForDispatch(other.id)
    await Promise.resolve()
    expect(current.sections.talkingWith.some((row) => row.pendingQuestion)).toBe(false)
    const released = count()
    stop()
    f.db.insertMessage({ from: 'term_peer', to: 'term_coord', subject: 'after release' })
    await Promise.resolve()
    expect(count()).toBe(released)
  } finally {
    stop()
    clock.mockRestore()
  }
})

it('keeps true traffic cutoff independent of pending membership and excludes self', () => {
  const f = fixture()
  const self = f.assign('term_coord')
  const helper = f.assign('term_helper', 'term_worker')
  const pending = f.db.createQuestion({
    runId: f.run.id,
    dispatchId: helper.id,
    askerHandle: 'term_helper',
    question: 'attention survives cutoff'
  })
  f.db.createQuestion({
    runId: f.run.id,
    dispatchId: self.id,
    askerHandle: 'term_coord',
    question: 'not my own peer'
  })
  const at = Date.parse(pending.message.created_at)
  const read = (now: number) => buildCrewSnapshot('term_coord', { ...f.deps, now })
  const boundary = read(at + AGENT_STATUS_STALE_AFTER_MS)
  const rowAt = boundary.sections.talkingWith.find(
    (row) => row.pendingQuestion?.preview === 'attention survives cutoff'
  )
  expect(rowAt?.latest?.sequence).toBe(pending.message.sequence)
  const aged = read(at + AGENT_STATUS_STALE_AFTER_MS + 1)
  const rowAfter = aged.sections.talkingWith.find(
    (row) => row.pendingQuestion?.preview === 'attention survives cutoff'
  )
  expect(rowAfter).toHaveProperty('pendingQuestion')
  expect(rowAfter).not.toHaveProperty('latest')
  expect(
    Object.values(aged.sections)
      .flat()
      .some((row) => row.partyKey.endsWith('term_coord"]'))
  ).toBe(false)
})

it('folds pending representatives across committed clear aliases without fabricating Latest', () => {
  const f = fixture()
  const root = testOrcaSessionId('chat-pending-root')
  const next = testOrcaSessionId('chat-pending-next')
  const records = [
    agentSessionConversationView(
      agentSessionRecordFixture({
        sessionId: root,
        conversationCommand: {
          command: 'clear',
          state: 'completed',
          callerKey: 'pending-clear',
          phase: 'committed',
          replacementSessionId: next,
          operationId: 'pending-clear-one'
        }
      })
    ),
    agentSessionConversationView(agentSessionRecordFixture({ sessionId: next }))
  ]
  f.deps.records = {
    listRecords: () => records,
    getRecord: (id) => records.find((record) => record.sessionId === id) ?? null,
    getVisibleSessionTabIndex: () => ({ present: true, sessionIds: [next] })
  }
  const questions = [root, next].map((id) => {
    const dispatch = f.assign(`orca_session_id:${id}`, 'term_worker')
    return f.db.createQuestion({
      runId: f.run.id,
      dispatchId: dispatch.id,
      askerHandle: `orca_session_id:${id}`,
      question: `pending ${id}`
    })
  })
  const now = Date.parse(questions[1].message.created_at) + AGENT_STATUS_STALE_AFTER_MS + 1
  const snapshot = () => buildCrewSnapshot('term_coord', { ...f.deps, now })
  let peers = snapshot().sections.talkingWith
  expect(peers).toHaveLength(1)
  expect(peers[0]).toMatchObject({
    partyKey: JSON.stringify(['test-host', `orca_session_id:${root}`]),
    pendingQuestion: { preview: `pending ${next}` },
    openTarget: { kind: 'chat', sessionId: next }
  })
  expect(peers[0]).not.toHaveProperty('latest')
  f.db.answerQuestion({
    messageId: questions[1].message.id,
    runId: f.run.id,
    consumerGeneration: f.run.consumer_generation,
    body: 'answered representative'
  })
  peers = snapshot().sections.talkingWith
  expect(peers).toHaveLength(1)
  expect(peers[0].pendingQuestion?.preview).toBe(`pending ${root}`)
  expect(peers[0]).not.toHaveProperty('latest')
})
