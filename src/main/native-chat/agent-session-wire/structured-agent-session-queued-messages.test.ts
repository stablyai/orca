import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
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
const drafts: QueuedMessageTestRig['drafts'] = (...args) => rig.drafts(...args)

describe('/clear', () => {
  function clear(clientOperationId: string) {
    const fields = { command: 'clear' as const }
    return host.conversationCommand(CALLER, {
      envelope: rig.envelope(fields, 'agentSession.conversationCommand', clientOperationId),
      ...fields
    })
  }

  it('a clear with no drafts keeps the existing conversation open', async () => {
    const cleared = await clear(hostTestOperationId())
    expect(cleared).toMatchObject({ ok: true, value: { command: 'clear', state: 'completed' } })
    const replacementId = cleared.ok ? SESSION : undefined
    if (!replacementId) {
      throw new Error('expected clear to succeed')
    }
    expect(host.hasSession(replacementId)).toBe(true)
    expect(await drafts(replacementId)).toHaveLength(0)
  })
})
