import { afterEach, expect, it, vi } from 'vitest'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from './structured-agent-session-host-test-data'

let rig: QueuedMessageTestRig | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  await rig?.dispose()
  rig = undefined
})

function stopParams(r: QueuedMessageTestRig, clientMessageId?: string) {
  const fields =
    clientMessageId === undefined
      ? {}
      : { stopTarget: { kind: 'submission' as const, clientMessageId } }
  return { ...fields, envelope: r.envelope(fields, 'agentSession.cancel', hostTestOperationId()) }
}

for (const repeat of ['targeted', 'unnamed'] as const) {
  it(`a ${repeat} Stop after a Stop that failed still tries to stop the waiting send`, async () => {
    rig = await createQueuedMessageTestRig({ restartable: true })
    const first = await rig.workingSend()
    // The interrupt fails and the child's exit cannot be proven: the send may run on.
    rig.cancelTurn.mockImplementationOnce(async () => {
      throw new Error('interrupt timed out')
    })
    rig.closeSession.mockImplementationOnce(async () => {
      throw new Error('exit not proven')
    })
    expect(await rig.host.cancel(QUEUED_RIG_CALLER, stopParams(rig, first))).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_unknown' }
    })
    expect(rig.host.collaboratorsForTests().sessions.get(SESSION)?.child).toBeTruthy()
    expect(await rig.submission(first)).toMatchObject({ dispatchState: 'pending' })
    const tries = rig.cancelTurn.mock.calls.length + rig.closeSession.mock.calls.length
    await rig.host.cancel(
      QUEUED_RIG_CALLER,
      stopParams(rig, repeat === 'targeted' ? first : undefined)
    )
    expect(rig.cancelTurn.mock.calls.length + rig.closeSession.mock.calls.length).toBeGreaterThan(
      tries
    )
  })
}
