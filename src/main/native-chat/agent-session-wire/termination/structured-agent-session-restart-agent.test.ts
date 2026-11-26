import { afterEach, expect, it } from 'vitest'
import type { AgentSessionIdleConfirmation } from '../providers/structured-agent-session-adapter'
import { eventually } from '../host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'
import {
  acceptedDispatch,
  collectSubscriber,
  createRestTestRig,
  foundRestTestChat,
  readerSaw,
  REST_TEST_CALLER,
  restTestSend,
  type RestTestRig
} from '../host/testing/structured-agent-session-rest-test-rig.test-fixture'
import { HOST_TEST_SESSION as SESSION } from '../host/testing/structured-agent-session-host-test-data.test-fixture'

let rig: RestTestRig

afterEach(async () => {
  await rig.dispose()
})

it('Restart chat keeps the agent for a message sent while it waits on the idle answer', async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 3_600_000 } })
  await foundRestTestChat(rig)
  // The agent's own "busy" keeps it, so this only waits until the host sees no open work.
  rig.adapter.confirmIdle.mockImplementation(() => Promise.resolve('busy'))
  await eventually(async () => {
    expect(await rig.host.releaseIdleSession(SESSION, true)).toBe('busy')
    expect(rig.adapter.confirmIdle).toHaveBeenCalled()
  })

  let answerIdle = (): void => {}
  rig.adapter.confirmIdle.mockReset()
  rig.adapter.confirmIdle.mockImplementation(
    () =>
      new Promise<AgentSessionIdleConfirmation>((resolve) => (answerIdle = () => resolve('idle')))
  )
  const restart = rig.host.releaseIdleSession(SESSION, true)
  await eventually(() => expect(rig.adapter.confirmIdle).toHaveBeenCalled())
  let deliver = (): void => {}
  rig.adapter.dispatch.mockImplementationOnce(
    () => new Promise((resolve) => (deliver = () => resolve(acceptedDispatch())))
  )
  const fence = rig.store.getConversation(SESSION)!.currentFence
  expect(await rig.host.send(REST_TEST_CALLER, restTestSend('and then?', fence))).toMatchObject({
    ok: true
  })
  await eventually(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(2))
  answerIdle()

  expect(await restart).toBe('busy')
  deliver()
  const reader = collectSubscriber()
  await rig.host.subscribe({ id: 'reader', sessionId: SESSION, emit: reader.emit })
  await eventually(() => expect(readerSaw(reader.events).texts).toEqual(['hello', 'and then?']))
  expect(rig.adapter.closeSession).not.toHaveBeenCalled()
  expect(rig.adapter.acquire).toHaveBeenCalledTimes(1)
})
