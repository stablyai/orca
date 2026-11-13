import { afterEach, expect, it } from 'vitest'
import {
  assertTestJournalHistoricalInputs,
  finishTestJournalHistoricalInputs
} from '../../../agent-session-journal/replay/journal-historical-inputs.test-support'
import {
  appendTestJournalQueueRow,
  openTestJournalHostDatabase,
  readTestJournalOutcomes
} from '../../../agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { outcomeFormat1StoredScalars } from '../../../agent-session-journal/outcomes/journal-outcome-format-1'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER as CALLER
} from './structured-agent-session-queued-message-rig.test-fixture'

import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'
import type { QueuedMessageTestRig } from './structured-agent-session-queued-message-rig.test-fixture'
import { structuredQueuePauses } from '../../delivery/structured-agent-session-queued-pause'
import { openRigTurnFor } from './structured-agent-session-queued-rig-turn.test-fixture'
import { readAgentJournalTurn } from '../../../../../shared/agent-session/lifecycle/agent-session-turn-record'

let rig: QueuedMessageTestRig
afterEach(async () => rig.dispose())
const MANUAL_IDLE_SWEEP = { idleMs: () => 0, intervalMs: 60 * 60 * 1000 }
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
/** As the startup ceiling expiring the start in flight. */
async function failStartAtCeiling(): Promise<void> {
  const { lifetime, serialize, sessions } = rig.host.collaboratorsForTests()
  lifetime.stopStartingChild(SESSION, sessions.get(SESSION)?.child ?? null)
  await serialize(SESSION, async () => {})
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

it('a failed personal start retains Stop after its returned input is deleted', async () => {
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
  const personal = rig.send('personal input after Stop')
  await eventually(() =>
    expect(rig.host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase).toBe('starting')
  )

  await failStartAtCeiling()
  await personal.result

  expect(stopEvents().map((event) => event.reason)).toEqual(['user-stop', 'host-stop'])
  expect(journal().queuedMessages.userStopInForce()?.event.reason).toBe('user-stop')
  await eventually(async () =>
    expect(await rig.drafts()).toContainEqual({ messageId: personal.id, state: 'returned' })
  )
  expect(await rig.handoff(held)).toBeUndefined()
  expect(await rig.deleteQueued(personal.id)).toMatchObject({ value: { deleted: true } })
  expect(journal().queuedMessages.userStopInForce()?.event.reason).toBe('user-stop')
  expect(await rig.handoff(held)).toBeUndefined()
  expect(await rig.resume()).toMatchObject({ value: { resumed: true } })
  await eventually(async () => expect(await rig.handoff(held)).toBeDefined())
})

it('an unattended failed start preserves a manual Stop without returning the mail', async () => {
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
  const mail = rig.send('mail for the lead', undefined, {
    internal: true,
    from: {
      kind: 'agent',
      senders: [],
      orchestration: {
        message: 'mail-notice',
        mailbox: 'agent:worker',
        dispatchId: null,
        messages: []
      }
    }
  })
  await eventually(() =>
    expect(rig.host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase).toBe('starting')
  )

  await failStartAtCeiling()
  await mail.result

  expect(journal().queuedMessages.get(mail.id)).toBeNull()
  expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
  expect(await rig.handoff(held)).toBeUndefined()
})

it.each(['host-stop', 'user-close', 'user-close-before-exit'] as const)(
  'preserves Stop and the distinct %s ownership across legacy close and reopen',
  async (cause) => {
    rig = await createQueuedMessageTestRig({
      restartable: true,
      legacyInputs: true,
      probeOwner: async () => ({ outcome: 'pid-absent' })
    })
    const first = await rig.workingSend()
    await rig.settleAccepted(first, 'first')
    await openRigTurnFor(rig, first)
    const held = hostTestOperationId()
    const db = openTestJournalHostDatabase(rig.root).db
    assertTestJournalHistoricalInputs(db, journal())
    appendTestJournalQueueRow(db, journal(), held, {
      op: 'queued',
      body: hostTestMessage('keep this stopped'),
      position: 1,
      queuedAt: journal().physicalCursor()
    })
    expect(journal().queuedMessages.get(held)?.unattended).toBeUndefined()
    expect(await rig.stop()).toMatchObject({ ok: true })
    finishTestJournalHistoricalInputs(journal())
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
    const mailOptions = {
      internal: true as const,
      from: {
        kind: 'agent' as const,
        senders: [],
        orchestration: {
          message: 'mail-notice' as const,
          mailbox: 'agent:worker',
          dispatchId: null,
          messages: []
        }
      }
    }
    const mail = rig.send('mail on the stopped chat', undefined, mailOptions)
    await mail.result
    await eventually(async () =>
      expect((await rig.submission(mail.id))?.handedOverAt).toBeDefined()
    )
    await rig.settleAccepted(mail.id, 'mail')
    await openRigTurnFor(rig, mail.id)
    if (cause === 'user-close-before-exit') {
      const oldSession = rig.host.collaboratorsForTests().sessions.get(SESSION)!
      const previousEnd = oldSession.lastEndedChild
      rig.closeSession.mockImplementationOnce(async () => {
        await oldSession.child?.close?.recorded
        return false
      })
      await expect(rig.host.close(SESSION, 'user-close')).rejects.toThrow()
      expect(oldSession.lastEndedChild).toBe(previousEnd)
      expect(
        oldSession.journal
          .snapshot()
          .items.flatMap((item) => readAgentJournalTurn(item.body) ?? [])
          .find((turn) => turn.turnId === `turn-of-${mail.id}`)
      ).toMatchObject({ state: 'running' })
      await oldSession.journal.close()
      await rig.crashRestartHostFromDisk()
      expect(rig.host.collaboratorsForTests().sessions.has(SESSION)).toBe(false)
      await rig.host.reconcileRestartLeases()
    } else if (cause === 'user-close') {
      await rig.host.close(SESSION, 'user-close')
    } else {
      const collab = rig.host.collaboratorsForTests()
      await collab.serialize(SESSION, () =>
        collab.lifetime.stopAgent(SESSION, { cause: 'host-stop' })
      )
    }
    const afterExit = await rig.host.journalSnapshot(SESSION)
    const turn = afterExit.items
      .flatMap((item) => readAgentJournalTurn(item.body) ?? [])
      .find((entry) => entry.turnId === `turn-of-${mail.id}`)
    const pauseAfterExit = await rig.queuePause()
    const offersAfterExit = await rig.restartOffers()
    await rig.host.close(SESSION, 'evict')
    rig.crashRestartHostProcess()
    await rig.host.journalSnapshot(SESSION)
    const mail2 = rig.send('mail after reopen', undefined, mailOptions)
    expect(await mail2.result).toMatchObject({ ok: true })
    await eventually(async () =>
      expect((await rig.submission(mail2.id))?.handedOverAt).toBeDefined()
    )
    await rig.settleAccepted(mail2.id, 'mail2')
    await openRigTurnFor(rig, mail2.id, 'completed', 'success')
    await rig.host.collaboratorsForTests().serialize(SESSION, async () => {})
    const pauseAfterMail = await rig.queuePause()
    const leaked = await rig.handoff(held)
    const resumed = await rig.resume()
    await eventually(async () => expect(await rig.handoff(held)).toBeDefined())
    expect(resumed).toMatchObject({ ok: true, value: { resumed: true } })
    expect(turn).toMatchObject({
      state: 'interrupted',
      ...(cause !== 'host-stop' ? { outcome: 'cancellation' } : {})
    })
    if (cause === 'host-stop') {
      expect(turn?.outcome).toBeUndefined()
    }
    expect(offersAfterExit).toEqual([])
    expect(pauseAfterExit).toEqual(cause === 'host-stop' ? { reason: 'stopped' } : null)
    expect(pauseAfterMail).toEqual({ reason: 'stopped' })
    expect(leaked).toBeUndefined()
    expect(
      (await rig.host.journalSnapshot(SESSION)).submissions.filter(
        (entry) => entry.queuedMessageId === held
      )
    ).toHaveLength(1)
  }
)
