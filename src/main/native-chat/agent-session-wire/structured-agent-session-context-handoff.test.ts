import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from './structured-agent-session-host-test-data'

let rig: QueuedMessageTestRig
beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
})
afterEach(() => rig.dispose())

async function handoff(context = 'Keep the selected blue design.') {
  const { cursor } = await rig.host.journalSnapshot(SESSION)
  const fields = { command: 'clear' as const, handoff: { context, cursor } }
  return {
    ...fields,
    envelope: rig.envelope(fields, 'agentSession.conversationCommand', hostTestOperationId())
  }
}

it('keeps the exact next message and delivers durable context only once', async () => {
  const working = await rig.workingSend()
  await rig.settleAccepted(working, 'answer')
  const params = await handoff()
  expect(await rig.host.conversationCommand(CALLER, params)).toMatchObject({ ok: true })
  expect(rig.store.getRecord(SESSION)?.providerContextBoundary?.handoff).toBe(
    params.handoff.context
  )
  // Replaying an acknowledged clear must not reset the boundary a second time.
  expect(await rig.host.conversationCommand(CALLER, params)).toMatchObject({ ok: true })
  const message = 'My latest instruction: keep  two spaces.\nAnd this newline.'
  const next = rig.send(message)
  await next.result
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(2))
  const sent = rig.dispatch.mock.calls[1][0].body
  expect(sent.blocks).toEqual([
    { type: 'text', text: expect.stringContaining(params.handoff.context) },
    ...rig.dispatch.mock.calls[0][0].body.blocks,
    { type: 'text', text: 'End of historical context. The current user message follows.' },
    { type: 'text', text: message }
  ])
  const snapshot = await rig.host.journalSnapshot(SESSION)
  expect(
    snapshot.items.some(
      (item) =>
        item.body.kind === 'message' &&
        item.body.blocks.length === 1 &&
        item.body.blocks[0].type === 'text' &&
        item.body.blocks[0].text === message
    )
  ).toBe(true)
  await rig.settleAccepted(next.id, 'second-answer')
  const later = rig.send('One more instruction')
  await later.result
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(3))
  expect(rig.dispatch.mock.calls[2][0].body.blocks).toEqual([
    { type: 'text', text: 'One more instruction' }
  ])
})

it('refuses stale context before stopping the provider or changing its history', async () => {
  const working = await rig.workingSend()
  await rig.settleAccepted(working, 'answer')
  const params = await handoff()
  const newer = rig.send('This arrived while the summary was being generated')
  await newer.result
  expect(await rig.host.conversationCommand(CALLER, params)).toMatchObject({
    ok: false,
    refusal: { details: { reason: 'handoffContextStale' } }
  })
  expect(rig.closeSession).not.toHaveBeenCalled()
  expect(rig.store.getRecord(SESSION)?.providerContextBoundary).toBeUndefined()
})

it('does not accept handoff context for compact', async () => {
  const params = await handoff()
  expect(
    await rig.host.conversationCommand(CALLER, { ...params, command: 'compact' })
  ).toMatchObject({ ok: false })
  expect(rig.compact).not.toHaveBeenCalled()
})

it('retains handoff context when the host restarts before the next message', async () => {
  const working = await rig.workingSend()
  await rig.settleAccepted(working, 'answer')
  expect(await rig.host.conversationCommand(CALLER, await handoff())).toMatchObject({ ok: true })
  await rig.restartHostProcess()
  const next = rig.send('Continue after the restart')
  await next.result
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(2))
  expect(rig.dispatch.mock.calls[1][0].body.blocks[0]).toMatchObject({
    text: expect.stringContaining('Keep the selected blue design.')
  })
})

it('retains context after a provably rejected first delivery', async () => {
  const working = await rig.workingSend()
  await rig.settleAccepted(working, 'answer')
  expect(await rig.host.conversationCommand(CALLER, await handoff())).toMatchObject({ ok: true })
  const first = rig.send('First attempt')
  await first.result
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(2))
  await rig.settleRejected(first.id, 'Provider refused the input')
  const retry = rig.send('Try again')
  await retry.result
  await eventually(() => expect(rig.dispatch).toHaveBeenCalledTimes(3))
  expect(
    rig.dispatch.mock.calls[2][0].body.blocks.some(
      (block) => block.type === 'text' && block.text.includes('Keep the selected blue design.')
    )
  ).toBe(true)
})
