import { afterEach, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { agentSessionStopTarget } from '../../../shared/agent-session-stop-target'
import {
  adapterFor,
  fakeCodex,
  THREAD_ID as THREAD
} from '../../codex/codex-structured-session-adapter-fixture'
import { codexTurnLifecycleFake } from '../../codex/codex-turn-lifecycle-fake'
import {
  createRestTestRig,
  REST_TEST_CALLER as CALLER,
  restTestSend,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import type { CodexStructuredSessionAdapter } from '../../codex/codex-structured-session-adapter'

let rig: RestTestRig | undefined
let adapter: CodexStructuredSessionAdapter | undefined
afterEach(async () => {
  await adapter?.closeAll()
  await rig?.dispose()
  rig = undefined
  adapter = undefined
})

async function submittedTurn() {
  const codex = fakeCodex()
  const notify = (method: string, params: unknown) =>
    codex.connections.at(-1)?.handlers.onNotification?.(method, params)
  const turns = codexTurnLifecycleFake(THREAD, () => notify)
  Object.assign(codex.routes, turns.routes)
  const provider = adapterFor(codex, {}, [], {
    onDispatchSettledLate: (settlement) => void rig?.host.settleLateDispatch(settlement),
    onEvent: (event) => {
      if (event.type === 'ended' && 'cause' in event) {
        void rig?.host.handleAdapterEvent(event)
      }
    }
  })
  adapter = provider
  const current = await createRestTestRig({ adapter: provider })
  rig = current
  expect(await current.host.attach(CALLER, hostTestAttachParams(null))).toMatchObject({ ok: true })
  const send = restTestSend('work on this')
  expect(await current.host.send(CALLER, send)).toMatchObject({ ok: true })
  const id = send.envelope.clientOperationId
  await vi.waitFor(() =>
    expect(
      provider.observeSubmissionTurn({ sessionId: SESSION, clientMessageId: id, fence: 1 })
    ).toEqual({ verdict: 'live', turnId: 'turn-1' })
  )
  const snapshot = await current.host.journalSnapshot(SESSION)
  const stopTarget = agentSessionStopTarget(null, snapshot.submissions, 1)
  expect(stopTarget).toEqual({ kind: 'submission', clientMessageId: id })
  const envelope = {
    sessionId: SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: 1,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method: 'agentSession.cancel',
      sessionId: SESSION,
      fields: { stopTarget }
    })
  }
  const interrupts = () =>
    codex.connections[0]!.calls.filter((call) => call.method === 'turn/interrupt')
  return { current, provider, turns, notify, id, params: { stopTarget, envelope }, interrupts }
}

it('interrupts the bound turn when it opens after the client captures a submission Stop', async () => {
  const { current, turns, id, params, interrupts } = await submittedTurn()
  turns.start()
  await current.host.flushStreamedEvents(SESSION)
  expect(
    (await current.host.journalSnapshot(SESSION)).submissions.find(
      (row) => row.clientMessageId === id
    )
  ).toMatchObject({ providerItemId: null, dispatchState: 'pending' })
  expect(await current.host.cancel(CALLER, params)).toMatchObject({
    ok: true,
    value: { cancelled: true }
  })
  expect(interrupts()).toMatchObject([{ params: { threadId: THREAD, turnId: 'turn-1' } }])
  expect(
    current.store.getOperationRow(CALLER.callerKey, params.envelope.clientOperationId)
  ).toBeNull()
})

it('interrupts the admitted turn before its started notification or user echo', async () => {
  const { current, turns, params, interrupts } = await submittedTurn()
  turns.run()
  expect(await current.host.cancel(CALLER, params)).toMatchObject({
    ok: true,
    value: { cancelled: true }
  })
  expect(interrupts()).toMatchObject([{ params: { turnId: 'turn-1' } }])
})

it('reports an unconfirmed Stop immediately when the admitted turn cannot yet take an interrupt', async () => {
  const { current, turns, params, interrupts } = await submittedTurn()
  expect(await current.host.cancel(CALLER, params)).toMatchObject({
    ok: false,
    refusal: { code: 'agent_session_operation_unknown' }
  })
  expect(interrupts()).toHaveLength(1)
  expect(turns.turnId).toBe('turn-1')
  expect(current.host.collaboratorsForTests().sessions.get(SESSION)?.child).toBeDefined()
})

it('reports unavailable binding without interrupting a turn it cannot identify', async () => {
  const { current, provider, turns, id, params, interrupts } = await submittedTurn()
  turns.start()
  await current.host.flushStreamedEvents(SESSION)
  vi.spyOn(provider, 'observeSubmissionTurn').mockReturnValue({ verdict: 'unverifiable' })
  expect(await current.host.cancel(CALLER, params)).toMatchObject({
    ok: false,
    refusal: { code: 'agent_session_operation_unknown' }
  })
  expect(interrupts()).toHaveLength(0)
  expect(
    (await current.host.journalSnapshot(SESSION)).submissions.find(
      (row) => row.clientMessageId === id
    )?.providerItemId
  ).toBeNull()
})

it('does not interrupt later work after the bound turn ends without a user echo', async () => {
  const { current, turns, params, interrupts } = await submittedTurn()
  turns.start()
  turns.end('completed')
  await current.host.flushStreamedEvents(SESSION)
  expect(await current.host.send(CALLER, restTestSend('later work'))).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(turns.turnId).toBe('turn-2'))
  turns.start()
  await current.host.flushStreamedEvents(SESSION)
  expect(await current.host.cancel(CALLER, params)).toMatchObject({
    ok: true,
    value: { cancelled: false }
  })
  expect(interrupts()).toHaveLength(0)
  expect(turns.turnId).toBe('turn-2')
})

it('does not interrupt a later journal turn while an older submission binding remains', async () => {
  const { current, notify, params, interrupts } = await submittedTurn()
  notify('turn/started', { threadId: THREAD, turn: { id: 'unrelated' } })
  await current.host.flushStreamedEvents(SESSION)
  expect(await current.host.cancel(CALLER, params)).toMatchObject({
    ok: true,
    value: { cancelled: false }
  })
  expect(interrupts()).toHaveLength(0)
})

it('keeps a positively interrupted target quiet when its Stop is retried', async () => {
  const { current, turns, params, interrupts } = await submittedTurn()
  turns.start()
  await current.host.flushStreamedEvents(SESSION)
  expect(await current.host.cancel(CALLER, params)).toMatchObject({
    ok: true,
    value: { cancelled: true }
  })
  expect(await current.host.cancel(CALLER, params)).toMatchObject({
    ok: true,
    value: { cancelled: false }
  })
  expect(interrupts()).toHaveLength(1)
})
