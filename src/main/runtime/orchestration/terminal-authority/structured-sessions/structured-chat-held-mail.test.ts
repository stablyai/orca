import '../../../rpc/dispatch/testing/unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import { failedWorker, healthySibling } from './structured-chat-failed-worker.test-fixture'
import {
  COORDINATOR,
  PEER_CHAT,
  WAIT,
  call,
  db,
  dispatcher,
  host,
  root,
  request,
  sendUserMessage,
  settleTurn
} from './structured-chat-coordinator-mail-rig.test-fixture'
import { JournalSqlOwner } from '../../../../native-chat/agent-session-journal/journal-sql-owner'
import { runProcess } from '@orca/process-host'
import { join } from 'node:path'
import { OrchestrationError } from '../../orchestration-error'

it('keeps group recipient outcomes negative for legacy retries without duplicating mail', async () => {
  const { dispatchId } = await failedWorker()
  await healthySibling()
  const input = request(
    'orchestration.send',
    { to: '@all', subject: 'group instruction' },
    { sessionId: COORDINATOR }
  )
  const first = await dispatcher.dispatch(input)
  expect(first).toMatchObject({
    ok: false,
    error: {
      code: 'recipient_delivery_held',
      data: {
        delivered: false,
        state: 'held',
        deliveries: expect.arrayContaining([
          expect.objectContaining({
            message: expect.objectContaining({ to_handle: `dispatch:${dispatchId}` }),
            delivered: false,
            state: 'held',
            waiting: 1
          }),
          expect.objectContaining({ delivered: false, state: 'queued' })
        ])
      }
    }
  })
  expect(await dispatcher.dispatch(input)).toMatchObject({
    ok: false,
    error: { code: 'recipient_delivery_held' }
  })
  expect(
    db
      .getUnreadMessages(`dispatch:${dispatchId}`)
      .filter((row) => row.subject === 'group instruction')
  ).toHaveLength(1)
  expect(await host.heldDelivery(PEER_CHAT)).toMatchObject({ waiting: 1 })
})

it('refreshes arbitrary later retries and prioritizes the saved message acceptance', async () => {
  const { dispatchId, worker, notify } = await failedWorker()
  const to = `dispatch:${dispatchId}`
  const input = request(
    'orchestration.send',
    { to, subject: 'one instruction', deliveryOutcome: true },
    { sessionId: COORDINATOR }
  )
  const initial = await dispatcher.dispatch(input)
  expect(initial).toMatchObject({ ok: true, result: { state: 'held', waiting: 1 } })
  if (
    !initial.ok ||
    !initial.result ||
    typeof initial.result !== 'object' ||
    !('failureId' in initial.result) ||
    typeof initial.result.failureId !== 'string' ||
    !('message' in initial.result) ||
    !initial.result.message ||
    typeof initial.result.message !== 'object' ||
    !('id' in initial.result.message) ||
    typeof initial.result.message.id !== 'string'
  ) {
    throw new Error('missing held receipt')
  }
  const held = { failureId: initial.result.failureId, message: { id: initial.result.message.id } }
  await dispatcher.dispatch(input)
  await dispatcher.dispatch(input)
  await call(
    'orchestration.send',
    { to, resume: true, expectedFailureId: held.failureId, subject: '', deliveryOutcome: true },
    { sessionId: COORDINATOR }
  )
  await vi.waitFor(() => expect(worker.turns).toHaveLength(2), WAIT)
  await settleTurn(PEER_CHAT, 1)
  await vi.waitFor(async () => {
    const attempt = db.getStructuredMailSend(to, held.message.id)
    expect(attempt && (await host.mailObservation(attempt)).state.kind).toBe('accepted')
  }, WAIT)
  for (let retry = 0; retry < 3; retry++) {
    expect(await dispatcher.dispatch(input)).toMatchObject({
      ok: true,
      result: { delivered: true, state: 'delivered', message: { id: held.message.id } }
    })
  }
  await sendUserMessage(PEER_CHAT, 'unrelated owner instruction')
  await vi.waitFor(() => expect(worker.turns).toHaveLength(3), WAIT)
  const error = { message: 'Network unavailable again', codexErrorInfo: 'httpConnectionFailed' }
  notify('turn/started', { turn: { id: 'turn-3' } })
  notify('error', { threadId: worker.threadId, turnId: 'turn-3', willRetry: false, error })
  notify('turn/completed', { turn: { id: 'turn-3', status: 'failed', error } })
  await host.flushStreamedEvents(PEER_CHAT)
  await vi.waitFor(
    async () => expect(await host.heldDelivery(PEER_CHAT)).toMatchObject({ state: 'held' }),
    WAIT
  )
  expect(await dispatcher.dispatch(input)).toMatchObject({
    ok: true,
    result: { delivered: true, state: 'delivered', message: { id: held.message.id } }
  })
  expect(db.getMessageById(held.message.id)?.subject).toBe('one instruction')
  expect(
    db.db
      .prepare(
        "SELECT COUNT(*) AS count FROM messages WHERE to_handle=? AND subject='one instruction'"
      )
      .get(to)?.count
  ).toBe(1)
})

it.each([false, true])(
  'keeps unreadable delivery unknown after custody, upgraded=%s',
  async (upgraded) => {
    const { dispatchId } = await failedWorker()
    const unreadable = vi
      .spyOn(host, 'heldDelivery')
      .mockRejectedValue(new Error('reader unavailable'))
    try {
      const input = request(
        'orchestration.send',
        {
          to: `dispatch:${dispatchId}`,
          subject: 'kept despite unreadable',
          ...(upgraded ? { deliveryOutcome: true } : {})
        },
        { sessionId: COORDINATOR }
      )
      expect(await dispatcher.dispatch(input)).toMatchObject(
        upgraded
          ? {
              ok: true,
              result: {
                delivered: false,
                state: 'unknown',
                target: { address: `dispatch:${dispatchId}` },
                message: { subject: 'kept despite unreadable' }
              }
            }
          : {
              ok: false,
              error: {
                code: 'recipient_delivery_unconfirmed',
                data: { delivered: false, state: 'unknown' }
              }
            }
      )
      expect(
        db
          .getUnreadMessages(`dispatch:${dispatchId}`)
          .some((row) => row.subject === 'kept despite unreadable')
      ).toBe(true)
    } finally {
      unreadable.mockRestore()
    }
  }
)

it.each(['before commit', 'after commit', 'other process', 'settled before', 'settled after'])(
  'fences a coordinator rebind %s at the writer boundary',
  async (edge) => {
    const { dispatchId, worker } = await failedWorker()
    const to = `dispatch:${dispatchId}`
    const held = await call(
      'orchestration.send',
      { to, subject: 'held work', deliveryOutcome: true },
      { sessionId: COORDINATOR }
    )
    const runId = db.getDispatchContextById(dispatchId)!.run_id
    const original = JournalSqlOwner.prototype.write
    let changed = false
    const write = vi.spyOn(JournalSqlOwner.prototype, 'write').mockImplementation(async function (
      this: JournalSqlOwner,
      command
    ) {
      const rebind = async () => {
        if (edge.startsWith('settled')) {
          db.completeDispatch(dispatchId)
          return
        }
        if (edge === 'other process') {
          const node =
            process.env.ORCA_TEST_NODE_EXECUTABLE ??
            (!process.versions.bun ? process.execPath : undefined)
          if (!node) {
            throw new Error('test requires the pinned Node runtime')
          }
          const generation = db.getRun(runId)!.consumer_generation
          const changed = await runProcess({
            program: node,
            args: [
              '-e',
              "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1], { timeout: 5000 }); db.prepare('UPDATE runs SET consumer_generation=consumer_generation+1 WHERE id=?').run(process.argv[2]); db.close()",
              join(root, 'orchestration.db'),
              runId
            ],
            cwd: root
          })
          expect(changed, changed.stderr).toMatchObject({ code: 0 })
          expect(db.getRun(runId)!.consumer_generation).toBe(generation + 1)
          return
        }
        db.bindRun({
          runId,
          coordinatorHandle: 'new-coordinator',
          coordinatorPaneKey: 'tab_new:11111111-1111-4111-8111-111111111111'
        })
      }
      if (command.operation.kind === 'failure-resume' && !changed) {
        changed = true
        if (edge !== 'after commit' && edge !== 'settled after') {
          await rebind()
        }
        const result = await original.call(this, command)
        if (edge === 'after commit' || edge === 'settled after') {
          await rebind()
        }
        return result
      }
      return original.call(this, command)
    })
    try {
      const answer = await dispatcher.dispatch(
        request(
          'orchestration.send',
          {
            to,
            subject: '',
            resume: true,
            expectedFailureId: held.failureId,
            deliveryOutcome: true
          },
          { sessionId: COORDINATOR }
        )
      )
      expect(answer, JSON.stringify(answer)).toMatchObject(
        edge !== 'after commit' && edge !== 'settled after'
          ? { ok: false, error: { code: 'worker_resume_blocked' } }
          : { ok: true, result: { state: 'resuming' } }
      )
      await host.flushStreamedEvents(PEER_CHAT)
      expect(await host.heldDelivery(PEER_CHAT)).toMatchObject({ state: 'held' })
      expect(worker.turns).toHaveLength(1)
    } finally {
      write.mockRestore()
    }
  }
)

it('serializes distinct coordinator recoveries of one observed failure', async () => {
  const { dispatchId, worker } = await failedWorker()
  const to = `dispatch:${dispatchId}`
  const held = await call(
    'orchestration.send',
    { to, subject: 'once', deliveryOutcome: true },
    { sessionId: COORDINATOR }
  )
  const resume = () =>
    dispatcher.dispatch(
      request(
        'orchestration.send',
        {
          to,
          resume: true,
          expectedFailureId: held.failureId,
          deliveryOutcome: true
        },
        { sessionId: COORDINATOR }
      )
    )
  const outcomes = await Promise.all([resume(), resume()])
  expect(outcomes.filter((answer) => answer.ok)).toHaveLength(1)
  expect(outcomes.filter((answer) => !answer.ok)).toEqual([
    expect.objectContaining({
      error: expect.objectContaining({ code: 'worker_resume_already-used' })
    })
  ])
  await vi.waitFor(() => expect(worker.turns).toHaveLength(2), WAIT)
  expect(
    db.db
      .prepare("SELECT COUNT(*) AS count FROM messages WHERE to_handle=? AND subject='once'")
      .get(to)?.count
  ).toBe(1)
})

it('does not redrive recovery when its outer receipt acknowledgment is lost', async () => {
  const { dispatchId } = await failedWorker()
  const to = `dispatch:${dispatchId}`
  const held = await call(
    'orchestration.send',
    { to, subject: 'saved', deliveryOutcome: true },
    { sessionId: COORDINATOR }
  )
  const params = { to, resume: true, expectedFailureId: held.failureId, deliveryOutcome: true }
  const intent = request('orchestration.send', params, { sessionId: COORDINATOR })
  const receipt = vi.spyOn(db, 'completeMutationReceipt').mockImplementationOnce(() => {
    throw new OrchestrationError('operation_unknown', 'acknowledgment lost after grant')
  })
  try {
    expect(await dispatcher.dispatch(intent)).toMatchObject({
      ok: false,
      error: { code: 'operation_unknown' }
    })
  } finally {
    receipt.mockRestore()
  }
  expect(await dispatcher.dispatch(intent)).toMatchObject({
    ok: false,
    error: { code: 'operation_unknown' }
  })
  expect(
    await dispatcher.dispatch(request('orchestration.send', params, { sessionId: COORDINATOR }))
  ).toMatchObject({
    ok: false,
    error: { code: 'worker_resume_already-used' }
  })
})
