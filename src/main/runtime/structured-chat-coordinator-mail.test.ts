import './rpc/unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../shared/agent-session-journal-item-key'
import { currentRunCoordinatorOrcaSessionId } from './orchestration/db/runs/run-coordinator-orca-session'
import { ordinaryMailCreationId } from './orchestration/structured-mailbox-pointer-delivery'
import { providerFaults } from './structured-chat-coordinator-fake-codex-fixture'
import { idOf } from './rpc/orchestration-session-caller-test-fixture'
import {
  COORDINATOR,
  PEER_CHAT,
  codex,
  runtime,
  db,
  host,
  dispatcher,
  observationClock,
  request,
  call,
  openChat,
  connectionFor,
  settleTurn,
  sendUserMessage,
  userTexts,
  finishWorker,
  coordinatorRunAndTask,
  clearChat,
  startClearedContext,
  WAIT,
  turnText,
  queuedCardTexts,
  restartRuntime
} from './structured-chat-coordinator-mail-rig.test-fixture'

const edgesAnswered = () => observationClock.edgesAnswered(runtime, WAIT)

it('commits a complete attributed report to the ordinary queue before execution; inbox check remains independent', async () => {
  const chat = await openChat(COORDINATOR)
  const { runId, taskId } = await coordinatorRunAndTask()
  await finishWorker(taskId)
  await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
  const [source] = db.getUnreadMessages(`run:${runId}`)
  expect(source.delivered_at).not.toBeNull()
  expect(turnText(chat.turns[0])).toContain('**Subject:** Done')
  const snapshot = await host.journalSnapshot(COORDINATOR)
  expect(
    snapshot.items.find(
      (item) => item.itemId === agentJournalSubmissionKey(snapshot.submissions[0].clientMessageId)
    )?.body
  ).toMatchObject({
    from: { kind: 'agent', orchestration: { messages: [{ messageId: source.id }] } }
  })
  runtime.deliverPendingMessagesForHandle(`run:${runId}`)
  await settleTurn(COORDINATOR, 0)
  await edgesAnswered()
  expect(chat.turns).toHaveLength(1)
  expect(await userTexts(COORDINATOR)).toHaveLength(1)
  const checked = await call('orchestration.check', {}, { sessionId: COORDINATOR })
  expect(checked).toMatchObject({
    runId,
    count: 1,
    messages: [{ type: 'worker_done', from_handle: 'term_worker' }]
  })
})

it.each(['exit-then-throw', 'throw-then-exit', 'before-echo'] as const)(
  'never reoffers chat-owned reports after provider failure, restart or repeated source edges (%s)',
  async (fault) => {
    observationClock.start()
    await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    if (fault === 'before-echo') {
      providerFaults.dieBeforeEveryEcho = true
    } else {
      providerFaults.crashOnTurnStart = fault
    }
    await finishWorker(taskId)
    await vi.waitFor(() => expect(providerFaults.turnStarts).toBe(1), WAIT)
    await edgesAnswered()
    const source = db.getUnreadMessages(`run:${runId}`)[0]
    expect(source.delivered_at).not.toBeNull()
    const id = ordinaryMailCreationId(source)
    expect(host.deps.store.readCommandReceipt({ kind: 'global' }, id)).toMatchObject({
      verdict: 'readable',
      receipt: { status: 'accepted', result: { kind: 'queued-draft', messageId: id } }
    })
    restartRuntime()
    for (let n = 0; n < 3; n++) {
      await edgesAnswered()
    }
    await observationClock.observe(500)
    expect(providerFaults.turnStarts).toBe(1)
    expect(await call('orchestration.check', {}, { sessionId: COORDINATOR })).toMatchObject({
      count: 1
    })
  }
)

it('does not consume ordinary capacity or an operation receipt on precreation refusal; acquisition recovery retries the same creation', async () => {
  const chat = await openChat(COORDINATOR)
  const { runId, taskId } = await coordinatorRunAndTask()
  const real = host.send.bind(host)
  const attempted: string[] = []
  const send = vi.spyOn(host, 'send').mockImplementationOnce(async (_caller, input) => {
    attempted.push(input.envelope.clientOperationId)
    return {
      ok: false,
      refusal: { code: 'agent_session_operation_invalid', message: 'not attached' }
    }
  })
  send.mockImplementation((caller, input) => {
    attempted.push(input.envelope.clientOperationId)
    return real(caller, input)
  })
  await finishWorker(taskId)
  await vi.waitFor(() => expect(attempted).toHaveLength(1), WAIT)
  const source = db.getUnreadMessages(`run:${runId}`)[0]
  expect(source.delivered_at).toBeNull()
  expect(
    host.deps.store.readCommandReceipt({ kind: 'global' }, ordinaryMailCreationId(source))
  ).toEqual({ verdict: 'absent' })
  runtime.deliverPendingMessagesForHandle(`run:${runId}`)
  await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
  expect(new Set(attempted)).toEqual(new Set([ordinaryMailCreationId(source)]))
})

it('enqueues while busy without steering, starts only after the entire personal turn, and preserves order across reports', async () => {
  const chat = await openChat(COORDINATOR)
  const { runId, taskId } = await coordinatorRunAndTask()
  await sendUserMessage(COORDINATOR, 'work')
  await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
  await finishWorker(taskId)
  await call('orchestration.send', { from: 'term_worker', to: `run:${runId}`, subject: 'second' })
  await vi.waitFor(async () => expect(await queuedCardTexts()).toHaveLength(2), WAIT)
  expect(chat.turns).toHaveLength(1)
  expect(chat.steers).toEqual([])
  await settleTurn(COORDINATOR, 0, 'completed')
  await vi.waitFor(() => expect(chat.turns).toHaveLength(2), WAIT)
  expect(turnText(chat.turns[1])).toContain('**Subject:** Done')
  await edgesAnswered()
  expect(chat.turns).toHaveLength(2)
  await settleTurn(COORDINATOR, 1, 'completed')
  await vi.waitFor(() => expect(chat.turns).toHaveLength(3), WAIT)
  expect(turnText(chat.turns[2])).toContain('**Subject:** second')
  await settleTurn(COORDINATOR, 2, 'completed')
  expect(await queuedCardTexts()).toEqual([])
})

describe('a /clear keeps the chat its orchestration address', () => {
  it("delivers the conversation's Run to its fresh context under the same address", async () => {
    await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    const generation = db.getRunRaw(runId)!.consumer_generation
    const cleared = await clearChat(COORDINATOR)
    expect(cleared).toBe(COORDINATOR)
    const opened = codex.connections.length

    await finishWorker(taskId)
    await vi.waitFor(() => expect(connectionFor(cleared).turns).toHaveLength(1), WAIT)
    const next = connectionFor(cleared)
    expect(codex.connections.slice(opened)).toEqual([next])
    expect(next.methods.filter((method) => method.startsWith('thread/'))).toEqual(['thread/start'])
    expect(turnText(next.turns[0]!)).toContain('**Subject:** Done')
    await settleTurn(cleared, 0)
    await expect(
      call('orchestration.runCurrent', {}, { sessionId: cleared })
    ).resolves.toMatchObject({ run: { id: runId } })
    await expect(call('orchestration.check', {}, { sessionId: cleared })).resolves.toMatchObject({
      runId,
      count: 1,
      messages: [{ type: 'worker_done' }]
    })
    expect(db.getRunRaw(runId)).toMatchObject({
      coordinator_orca_session_id: COORDINATOR,
      consumer_generation: generation
    })
  })

  it('keeps a Run under the same conversation address through repeated clears', async () => {
    await openChat(COORDINATOR)
    const firstClear = await clearChat(COORDINATOR)
    await startClearedContext(firstClear)
    const created = await call(
      'orchestration.runCreate',
      { objective: 'next' },
      { sessionId: firstClear }
    )
    const runId = idOf(created.run)
    expect(db.getRunRaw(runId)!.coordinator_orca_session_id).toBe(COORDINATOR)
    const cleared = await clearChat(firstClear)
    await startClearedContext(cleared)

    await expect(
      call('orchestration.runCurrent', {}, { sessionId: cleared })
    ).resolves.toMatchObject({ run: { id: runId } })
    expect(db.getRunRaw(runId)!.coordinator_orca_session_id).toBe(COORDINATOR)
    await openChat(PEER_CHAT)
    await expect(
      call(
        'orchestration.send',
        { to: `orca_session_id:${PEER_CHAT}`, subject: 'hi' },
        { sessionId: cleared }
      )
    ).resolves.toMatchObject({ message: { from_handle: `orca_session_id:${COORDINATOR}` } })
  })

  it('binds a Run a cleared chat creates or uses to the same conversation at the current generation', async () => {
    const root = COORDINATOR
    const boundOrcaSessionId = (runId: string): string | null =>
      currentRunCoordinatorOrcaSessionId(db.getRunRaw(runId)!)
    await openChat(COORDINATOR)
    const firstClear = await clearChat(COORDINATOR)
    await startClearedContext(firstClear)
    const first = idOf(
      (await call('orchestration.runCreate', { objective: 'first' }, { sessionId: firstClear })).run
    )
    expect(db.getRunRaw(first)).toMatchObject({
      coordinator_orca_session_id: root,
      coordinator_orca_session_id_generation: db.getRunRaw(first)!.consumer_generation
    })
    expect(boundOrcaSessionId(first)).toBe(root)
    const second = idOf(
      (await call('orchestration.runCreate', { objective: 'second' }, { sessionId: firstClear }))
        .run
    )
    expect(boundOrcaSessionId(first)).toBeNull()

    const cleared = await clearChat(firstClear)
    await startClearedContext(cleared)
    await call('orchestration.runUse', { id: first }, { sessionId: cleared })
    const rebound = db.getRunRaw(first)!
    expect(rebound.coordinator_orca_session_id).toBe(root)
    expect(rebound.coordinator_orca_session_id_generation).toBe(rebound.consumer_generation)
    expect(boundOrcaSessionId(second)).toBeNull()
    await expect(
      call('orchestration.runCurrent', {}, { sessionId: cleared })
    ).resolves.toMatchObject({ run: { id: first } })
  })

  it('lands successive mail at the same conversation after repeated clears', async () => {
    await openChat(PEER_CHAT)
    const firstClear = await clearChat(PEER_CHAT)
    const cleared = await clearChat(firstClear)
    expect(firstClear).toBe(PEER_CHAT)
    expect(cleared).toBe(PEER_CHAT)
    // The first ping starts the fresh context, which neither clear did.
    for (const [index, spelling] of [PEER_CHAT, firstClear, cleared].entries()) {
      const sent = await call('orchestration.send', {
        from: 'term_worker',
        to: `orca_session_id:${spelling}`,
        subject: `ping ${index}`
      })
      expect(sent).toMatchObject({ message: { to_handle: `orca_session_id:${PEER_CHAT}` } })
      await vi.waitFor(() => expect(connectionFor(cleared).turns).toHaveLength(index + 1), WAIT)
      await settleTurn(cleared, index)
      // Read each ping before the next is sent, so each check holds exactly one.
      const checked = await call('orchestration.check', {}, { sessionId: cleared })
      expect(checked).toMatchObject({ count: 1, messages: [{ subject: `ping ${index}` }] })
      await call('orchestration.check', { ack: checked.deliveryId }, { sessionId: cleared })
    }
  })
})

describe('any live session is addressable by its id', () => {
  it('lands mail sent to `orca_session_id:<id>` as a turn in that chat, which a flagless check reads', async () => {
    const peer = await openChat(PEER_CHAT)

    const sent = await call('orchestration.send', {
      from: 'term_worker',
      to: `orca_session_id:${PEER_CHAT}`,
      subject: 'ping'
    })
    expect(sent).toMatchObject({ message: { to_handle: `orca_session_id:${PEER_CHAT}` } })

    await vi.waitFor(() => expect(peer.turns).toHaveLength(1), WAIT)
    // Direct mail is not in a Run, so the pointer names no `--run`.
    expect(turnText(peer.turns[0]!)).toContain('**Subject:** ping')
    await settleTurn(PEER_CHAT, 0)
    const checked = await call('orchestration.check', {}, { sessionId: PEER_CHAT })
    expect(checked).toMatchObject({ count: 1, messages: [{ subject: 'ping' }] })
  })

  it('refuses mail to a chat that was closed, before storing it', async () => {
    await openChat(PEER_CHAT)
    await host.setSessionTabVisibility(PEER_CHAT, false)
    const response = await dispatcher.dispatch(
      request('orchestration.send', {
        from: 'term_worker',
        to: `orca_session_id:${PEER_CHAT}`,
        subject: 'ping'
      })
    )
    expect(response).toMatchObject({ ok: false, error: { code: 'session_caller_not_live' } })
    expect(db.getInbox(100)).toEqual([])
  })
})
