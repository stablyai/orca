import { afterEach, expect, it } from 'vitest'
import {
  openTestJournalHostDatabase,
  readTestJournalOutcomes
} from '../agent-session-journal/journal-host-database-test-support'
import { outcomeFormat1StoredScalars } from '../agent-session-journal/journal-outcome-format-1'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { structuredQueuePauses } from './structured-agent-session-queued-pause'

let rig: QueuedMessageTestRig
afterEach(async () => rig.dispose())
const MANUAL_IDLE_SWEEP = { idleMs: 0, intervalMs: 60 * 60 * 1000 }
function journal() {
  const value = rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal
  if (!value) {
    throw new Error('expected an open journal')
  }
  return value
}
type StoredStopEvent = NonNullable<
  ReturnType<typeof outcomeFormat1StoredScalars.shape.queuePauseMarks.parse>['latestStop']
>['event']

function stopEvents(): StoredStopEvent[] {
  const events = new Map<number, StoredStopEvent>()
  for (const row of readTestJournalOutcomes(openTestJournalHostDatabase(rig.root).db, SESSION)) {
    if (row.field === '$' && row.key === JSON.stringify('queuePauseMarks') && !row.deleted) {
      const { latestStop } = outcomeFormat1StoredScalars.shape.queuePauseMarks.parse(
        JSON.parse(row.json)
      )
      if (latestStop) {
        events.set(latestStop.sequence, latestStop.event)
      }
    }
  }
  return [...events.values()]
}
async function queuedDraft(text: string) {
  const queued = await rig.send(text, 'queue-if-active').result
  if (!queued.ok || !('queued' in queued.value)) {
    throw new Error('expected queued input')
  }
  return queued.value.queued.messageId
}

it('keeps Resume visible beside an idle-evicted unknown send recovery', async () => {
  rig = await createQueuedMessageTestRig({ restartable: true, idleSweep: MANUAL_IDLE_SWEEP })
  const working = await rig.workingSend()
  const held = await queuedDraft('queued behind the turn')
  expect(await rig.stop()).toMatchObject({ ok: true })
  await rig.host.collaboratorsForTests().serialize(SESSION, async () => {})
  await rig.settleAccepted(working, 'stopped')
  expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
  rig.dispatch.mockRejectedValueOnce(new Error('reply lost'))
  const id = hostTestOperationId()
  const fields = { body: hostTestMessage('sent after Stop, reply lost') }
  expect(
    await rig.host.send(CALLER, {
      envelope: {
        ...rig.envelope(fields, 'agentSession.send', id),
        expectedRuntimeFence: rig.store.getRecord(SESSION)!.lease.runtimeFence
      },
      ...fields,
      userSend: true
    })
  ).toMatchObject({ ok: true })
  await eventually(async () =>
    expect(await rig.submission(id)).toMatchObject({ dispatchState: 'unknown' })
  )
  const before = stopEvents()

  await rig.host.collaboratorsForTests().lifetime.idleSweep.tick()

  expect(stopEvents()).toEqual(before)
  expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
  expect(journal().submissionBody(id)).toEqual(fields.body)
  expect(journal().queuedMessages.get(`recovery:${id}`)).toBeNull()
  expect(journal().itemBody(`orca:${id}`)).toEqual(fields.body)
  expect(structuredQueuePauses(journal()).map((pause) => pause.reason)).toContain('stopped')
  expect(await rig.drafts()).toEqual([{ messageId: held, state: 'waiting' }])
  expect(await rig.handoff(held)).toBeUndefined()
  expect(await rig.deleteQueued(`recovery:${id}`)).toMatchObject({ value: { deleted: false } })
  expect(await rig.submission(id)).toMatchObject({ dispatchState: 'unknown' })
  expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
  expect(await rig.handoff(held)).toBeUndefined()
  expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
  await eventually(async () => expect(await rig.handoff(held)).toBeDefined())
  expect(await rig.submission(id)).toMatchObject({ dispatchState: 'unknown' })
  expect(rig.dispatch.mock.calls.filter(([send]) => send.clientMessageId === id)).toHaveLength(1)
})

it('a later failed-start Stop returns only its own card and holds older waiting input until exact Delete', async () => {
  rig = await createQueuedMessageTestRig({
    starting: true,
    restartable: true,
    idleSweep: MANUAL_IDLE_SWEEP
  })
  const working = await rig.workingSend()
  const held = await queuedDraft('queued behind the turn')
  expect(await rig.stop()).toMatchObject({ ok: true })
  await rig.settleAccepted(working, 'stopped')
  await rig.host.collaboratorsForTests().lifetime.idleSweep.tick()
  expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
  const mail = rig.send('mail for the lead')
  await eventually(() =>
    expect(rig.host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase).toBe('starting')
  )

  await rig.host.collaboratorsForTests().lifetime.idleSweep.tick()
  await mail.result

  expect(stopEvents().map((event) => event.reason)).toEqual(['user-stop', 'host-stop'])
  expect(await rig.queuePause()).not.toEqual({ reason: 'stopped' })
  await eventually(async () =>
    expect(await rig.drafts()).toContainEqual({ messageId: mail.id, state: 'returned' })
  )
  expect(await rig.handoff(held)).toBeUndefined()
  expect(await rig.deleteQueued(mail.id)).toMatchObject({ value: { deleted: true } })
  await eventually(async () => expect(await rig.handoff(held)).toBeDefined())
})
