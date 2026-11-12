import { beforeEach, expect, it, vi, type Mock } from 'vitest'
import type { StructuredAgentSessionAdapter } from '../../providers/structured-agent-session-adapter'
import {
  attach,
  CALLER,
  envelope,
  hostTestState
} from './structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION, hostTestMessage } from './structured-agent-session-host-test-data'

let state: ReturnType<typeof hostTestState>
let compact: Mock<NonNullable<StructuredAgentSessionAdapter['compact']>>

function compactParams() {
  return {
    command: 'compact' as const,
    envelope: envelope('agentSession.conversationCommand', { command: 'compact' })
  }
}

beforeEach(() => {
  state = hostTestState()
  compact = vi.fn(async () => ({ state: 'accepted' as const, providerIdentity: null }))
  Object.assign(state.host.deps.adapter, { compact })
})

it('keeps a direct failed-start command terminal until an explicit fresh rerun', async () => {
  await attach()
  await state.host.close(HOST_TEST_SESSION, 'evict')
  state.acquire.mockRejectedValueOnce(new Error('start refused'))
  const command = compactParams()
  await state.host.conversationCommand(CALLER, command)
  await vi.waitFor(async () => {
    const snapshot = await state.host.journalSnapshot(HOST_TEST_SESSION)
    expect(
      snapshot.submissions.find(
        (entry) => entry.clientMessageId === command.envelope.clientOperationId
      )
    ).toMatchObject({ dispatchState: 'rejected' })
  })
  const history = await state.host.history({ sessionId: HOST_TEST_SESSION, direction: 'tail' })
  expect(history.ok && history.page.queuedMessages).toEqual([])
  expect(compact).not.toHaveBeenCalled()
  const body = hostTestMessage('try personal work after the failure')
  expect(
    await state.host.send(CALLER, {
      envelope: envelope('agentSession.send', { body }),
      body,
      userSend: true
    })
  ).toMatchObject({ ok: true })
  await vi.waitFor(async () =>
    expect((await state.host.journalSnapshot(HOST_TEST_SESSION)).submissions.at(-1)).toMatchObject({
      dispatchState: 'accepted'
    })
  )
  await state.host.queuedMessagesResume(CALLER, {
    envelope: envelope('agentSession.queuedMessagesResume', {})
  })
  await state.host.collaboratorsForTests().serialize(HOST_TEST_SESSION, async () => {})
  expect(compact).not.toHaveBeenCalled()
  const replay = await state.host.conversationCommand(CALLER, command)
  expect(replay).toMatchObject({ replayed: true })
  expect(compact).not.toHaveBeenCalled()
  compact.mockRejectedValueOnce(new Error('ready child lost its reply'))
  const uncertain = compactParams()
  expect(await state.host.conversationCommand(CALLER, uncertain)).toMatchObject({ ok: true })
  await vi.waitFor(async () => {
    const snapshot = await state.host.journalSnapshot(HOST_TEST_SESSION)
    expect(
      snapshot.submissions.find(
        (entry) => entry.clientMessageId === uncertain.envelope.clientOperationId
      )
    ).toMatchObject({ dispatchState: 'unknown' })
  })
  await state.host.close(HOST_TEST_SESSION, 'evict')
  expect(
    await state.host.send(CALLER, {
      envelope: envelope('agentSession.send', { body }),
      body,
      userSend: true
    })
  ).toMatchObject({ ok: true })
  await vi.waitFor(async () =>
    expect((await state.host.journalSnapshot(HOST_TEST_SESSION)).submissions.at(-1)).toMatchObject({
      dispatchState: 'accepted'
    })
  )
  await state.host.queuedMessagesResume(CALLER, {
    envelope: envelope('agentSession.queuedMessagesResume', {})
  })
  await state.host.collaboratorsForTests().serialize(HOST_TEST_SESSION, async () => {})
  expect(compact).toHaveBeenCalledTimes(1)
  expect(
    (await state.host.journalSnapshot(HOST_TEST_SESSION)).submissions.find(
      (entry) => entry.clientMessageId === uncertain.envelope.clientOperationId
    )
  ).toMatchObject({ dispatchState: 'unknown' })
  expect(await state.host.conversationCommand(CALLER, compactParams())).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(compact).toHaveBeenCalledTimes(2))
})
