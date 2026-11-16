import { afterEach, beforeEach, expect, it } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalItemKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { openRigTurnFor } from './structured-agent-session-queued-rig-turn.test-fixture'
import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from './structured-agent-session-host-test-data.test-fixture'
import { createStructuredSessionObservationClock } from './structured-agent-session-observation-clock.test-fixture'

let rig: QueuedMessageTestRig
let currentRig: QueuedMessageTestRig | undefined
const observationClock = createStructuredSessionObservationClock(() => rig.host, SESSION)
beforeEach(() => observationClock.start())
let host: QueuedMessageTestRig['host']

beforeEach(async () => {
  currentRig = undefined
  rig = await createQueuedMessageTestRig({ restartable: true })
  currentRig = rig
  ;({ host } = rig)
})

afterEach(async () => {
  await observationClock.restoreBeforeCleanup(async () => {
    await currentRig?.dispose()
  })
})
it('a steer send waiting on approval joins the running turn when approval clears', async () => {
  const opener = await rig.workingSend()
  await rig.settleAccepted(opener, 'opening')
  await openRigTurnFor(rig, opener)
  const identity = { provider: 'orca' as const, clientMessageId: 'approval' }
  rig.providerEvents().appendItem(
    identity,
    {
      kind: 'approval',
      title: 'Run command',
      detail: null,
      subject: { kind: 'plan', text: 'Run the command' },
      options: [{ id: 'allow', label: 'Allow' }],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await host.flushStreamedEvents(SESSION)
  const queueOnly = rig.send('after the turn', 'queue-if-active')
  expect(await queueOnly.result).toMatchObject({
    ok: true,
    value: { queued: { messageId: queueOnly.id } }
  })
  const steer = rig.send('also do this')
  expect(await steer.result).toMatchObject({ ok: true, value: { queued: { messageId: steer.id } } })
  expect(await rig.handoff(steer.id)).toBeUndefined()
  const itemId = agentJournalItemKey(identity)
  const journal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const prompt = (await journal.reads.item(itemId))!
  const fields = { itemId, expectedRevision: prompt.revision, optionId: 'allow' }
  expect(
    await host.respondToPrompt(CALLER, {
      envelope: rig.envelope(fields, 'agentSession.respondTo:approval', hostTestOperationId()),
      kind: 'approval',
      ...fields
    })
  ).toMatchObject({ ok: true })
  await eventually(async () => expect((await rig.handoff(steer.id))?.handedOverAt).toBeDefined())
  expect(await rig.handoff(queueOnly.id)).toBeUndefined()
})
