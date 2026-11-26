import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  clearStructuredHostStub,
  dispatcher,
  hostCalls,
  installStructuredHostStub
} from '../protocol/structured-agent-session-rpc.test-fixture'
import {
  OPERATION,
  request,
  sendParams,
  SESSION
} from '../protocol/structured-agent-session-rpc-client.test-fixture'

beforeEach(installStructuredHostStub)
afterEach(clearStructuredHostStub)

it('only confirms absence after the send with the same id finishes admission', async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let admitted = false
  hostCalls.send.mockImplementation(async () => {
    entered.resolve()
    await release.promise
    admitted = true
    return { ok: false, refusal: { code: 'agent_session_operation_unknown' } }
  })
  hostCalls.sendAnswer = vi.fn(async (_sessionId: string, id: string) => ({
    kind: id === OPERATION && admitted ? 'waiting' : 'absent'
  }))
  const rpc = dispatcher()
  const send = rpc.dispatch(request('agentSession.send', sendParams()))
  await entered.promise
  const lookup = (clientMessageId: string) =>
    rpc.dispatch(request('agentSession.sendRecorded', { sessionId: SESSION, clientMessageId }))
  const checking = lookup(OPERATION)
  try {
    expect(await lookup('1800000000000-00000000000000000000000000000002')).toMatchObject({
      result: { recorded: false, confirmedAbsent: true }
    })
    expect(hostCalls.sendAnswer).not.toHaveBeenCalledWith(SESSION, OPERATION, true)
  } finally {
    release.resolve()
    await send
  }
  expect(await checking).toMatchObject({ result: { recorded: true } })
})

it('correlates accepted queue custody to the requested ID when no submission is available', async () => {
  hostCalls.sendAnswer = vi.fn(async () => ({ kind: 'accepted' }))
  expect(
    await dispatcher().dispatch(
      request('agentSession.sendRecorded', { sessionId: SESSION, clientMessageId: OPERATION })
    )
  ).toMatchObject({
    result: {
      recorded: true,
      submission: { clientMessageId: OPERATION, dispatchState: 'accepted', reason: null }
    }
  })
})
