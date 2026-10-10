import { afterEach, expect, it } from 'vitest'
import { agentSessionStopTarget } from '../../../shared/agent-session-stop-target'
import { publishCodexTurnLifecycle } from '../../codex/codex-structured-journal-translation-turns'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestOperationId
} from './structured-agent-session-host-test-data'

let rig: QueuedMessageTestRig | undefined
afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

async function openingSubmission() {
  const current = await createQueuedMessageTestRig()
  rig = current
  const id = await current.workingSend()
  const stopTarget = agentSessionStopTarget(
    null,
    (await current.host.journalSnapshot(SESSION)).submissions,
    1
  )
  expect(stopTarget).toEqual({ kind: 'submission', clientMessageId: id })
  const envelope = current.envelope({ stopTarget }, 'agentSession.cancel', hostTestOperationId())
  publishCodexTurnLifecycle({
    sink: current.providerEvents(),
    primaryThreadId: THREAD,
    sessionId: SESSION,
    threadId: THREAD,
    turnId: 'turn-opening',
    state: 'running'
  })
  await current.host.flushStreamedEvents(SESSION)
  expect((await current.submission(id))?.providerItemId).toBeNull()
  expect((await current.host.journalSnapshot(SESSION)).items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        body: expect.objectContaining({ turnId: 'turn-opening', state: 'running' })
      })
    ])
  )
  return { current, id, params: { stopTarget, envelope } }
}

it('does not silently discard a captured submission Stop before its user echo', async () => {
  const { current, params } = await openingSubmission()
  const response = await current.host.cancel(QUEUED_RIG_CALLER, params)
  expect(response).not.toMatchObject({ ok: true, value: { cancelled: false } })
  expect(response).toMatchObject({
    ok: false,
    refusal: { code: 'agent_session_operation_unknown' }
  })
  expect(current.cancelTurn).not.toHaveBeenCalled()
  expect(current.closeSession).not.toHaveBeenCalled()
})

it('the captured submission Stop reaches the turn after its user echo links it', async () => {
  const { current, id, params } = await openingSubmission()
  await current.host.settleLateDispatch({
    sessionId: SESSION,
    clientMessageId: id,
    providerIdentity: { provider: 'codex', threadId: THREAD, turnId: 'turn-opening', ordinal: 0 }
  })
  expect(await current.host.cancel(QUEUED_RIG_CALLER, params)).toMatchObject({
    ok: true,
    value: { cancelled: true }
  })
  expect(current.cancelTurn).toHaveBeenCalledOnce()
})
