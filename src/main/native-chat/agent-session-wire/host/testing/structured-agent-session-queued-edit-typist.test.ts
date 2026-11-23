import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from './structured-agent-session-host-test-data.test-fixture'
import {
  QUEUED_RIG_CALLER,
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

let rig: QueuedMessageTestRig

beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
})

afterEach(() => rig.dispose())

it('saves a queued edit with the host’s typist stamp, which the client never fingerprinted', async () => {
  await rig.workingSend()
  const queued = await rig.send('run the deploy', 'queue-if-active').result
  if (!queued.ok || !('queued' in queued.value)) {
    throw new Error('expected a queued receipt')
  }
  const { messageId } = queued.value.queued
  const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal
  const card = await journal?.queuedMessages.get(messageId)
  // What the client sends and fingerprints: its edit alone.
  const fields = {
    messageId,
    expectedBodyFingerprint: card?.fingerprint ?? '',
    text: 'run the deploy after review'
  }
  const edited = await rig.host.queuedMessageUpdate(QUEUED_RIG_CALLER, {
    envelope: rig.envelope(fields, 'agentSession.queuedMessageUpdate', hostTestOperationId()),
    ...fields,
    typedBy: { by: 'host' }
  })
  expect(edited).toMatchObject({ ok: true, value: { status: 'updated' } })
  expect((await journal?.queuedMessages.get(messageId))?.body.typedBy).toEqual({ by: 'host' })
})
