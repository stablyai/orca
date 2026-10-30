import { expect, it } from 'vitest'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'
import { eventually } from './structured-agent-session-queued-message-rig.test-fixture'
import { createRootDispatch } from '../../runtime/orchestration/db/root-dispatch-test-fixture'
import {
  rig,
  db,
  bridge,
  clock,
  journal,
  card,
  complete,
  mailWorkCounts,
  installMailQueueLifecycle
} from './structured-agent-session-mail-queue.test-fixture'
installMailQueueLifecycle()

it.each([100, 1000])(
  'retires terminal Run/Dispatch/direct history at N=%i and recovers later current routing through a whole ordinary turn',
  async (count) => {
    const working = await rig.workingSend()
    const run = db.createRun({
      objective: 'terminal mailbox retirement',
      coordinatorHandle: null,
      coordinatorPaneKey: null
    })
    const task = db.createTask({ runId: run.id, spec: 'terminal delivery still works' })
    const dispatch = createRootDispatch(db, task.id, 'terminal-worker')
    const recipients = [`run:${run.id}`, `dispatch:${dispatch.id}`, 'terminal-worker']
    const rows = db.insertMessages(
      Array.from({ length: count }, (_, n) => ({
        runId: run.id,
        from: 'worker',
        to: recipients[n % recipients.length]!,
        subject: `terminal-${n}`
      }))
    )
    await clock.observe(50)
    expect(mailWorkCounts()).toMatchObject({
      containers: 0,
      pendingIds: 0,
      reverseIds: 0,
      attempts: 0,
      timers: 0
    })
    for (const mailbox of recipients) {
      const ids = rows.filter((row) => row.to_handle === mailbox).map((row) => row.id)
      db.markAsDelivered(ids, mailbox)
      db.markAsRead(ids)
    }
    await clock.observe(50)
    expect(
      db.db.prepare('SELECT count(*) AS n FROM messages WHERE run_id = ?').get(run.id)?.n
    ).toBe(count)
    expect(mailWorkCounts()).toMatchObject({
      containers: 0,
      pendingIds: 0,
      reverseMemberships: 0,
      attempts: 0,
      deferred: 0,
      timers: 0
    })
    const held = db.insertMessage({
      runId: run.id,
      from: 'worker',
      to: 'uncreated-worker',
      subject: 'owed before native route'
    })
    await clock.observe(30)
    expect(mailWorkCounts().pendingIds).toBe(0)
    // The real committed route operation, rather than a manual bridge call, creates the opportunity.
    expect(db.routeDirectMessagePage('consumer', run.id, 'uncreated-worker').routedCount).toBe(1)
    const id = await card(held.id)
    expect(journal().queuedMessages.get(id)).toMatchObject({ state: 'waiting' })
    await eventually(() =>
      expect(mailWorkCounts()).toMatchObject({
        pendingIds: 0,
        reverseIds: 0,
        attempts: 0,
        deferred: 0
      })
    )
    expect(mailWorkCounts()).toMatchObject({ containers: 1, interests: 1 })
    // A live finite frontier keeps its actual pending object, even while empty.
    const pending = Reflect.get(bridge, 'work').pending('consumer')
    for (let n = 0; n < 4; n++) {
      bridge.onJournalActivity(SESSION)
      await clock.observe(10)
      expect(Reflect.get(bridge, 'work').pending('consumer')).toBe(pending)
    }
    expect(await rig.handoff(id)).toBeUndefined()
    await complete(working)
    await eventually(async () =>
      expect(await rig.handoff(id)).toMatchObject({ source: { kind: 'agent' } })
    )
    const submission = await rig.handoffId(id)
    expect(submission).not.toBe(id)
    const after = db.insertMessage({
      runId: run.id,
      from: 'worker',
      to: 'consumer',
      subject: 'next full report'
    })
    const next = await card(after.id)
    await clock.observe(30)
    expect(await rig.handoff(next)).toBeUndefined()
    await complete(submission)
    await eventually(async () => expect(await rig.handoff(next)).toBeDefined())
    await complete(await rig.handoffId(next))
    bridge.forgetSession(SESSION)
    expect(mailWorkCounts()).toEqual({
      containers: 0,
      pendingIds: 0,
      reverseIds: 0,
      reverseMemberships: 0,
      attempts: 0,
      interests: 0,
      deferred: 0,
      timers: 0
    })
    expect(
      db.db.prepare('SELECT count(*) AS n FROM messages WHERE run_id = ?').get(run.id)?.n
    ).toBe(count + 2)
    console.info(
      'source-owner-retirement',
      JSON.stringify({ count, durableRows: count + 2, ...mailWorkCounts() })
    )
  }
)
