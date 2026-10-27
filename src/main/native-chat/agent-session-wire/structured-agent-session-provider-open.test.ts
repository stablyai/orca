import { AgentSessionAcquisitionRefusal } from './structured-agent-session-adapter'
import { expect, it, vi } from 'vitest'
import type {
  StructuredAgentSessionProviderOpen,
  StructuredAgentSessionProviderOpenResult
} from './structured-agent-session-provider-open-contract'
import {
  CALLER,
  attach,
  attachParams,
  envelope,
  hostTestState
} from './structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION, hostTestMessage } from './structured-agent-session-host-test-data'

const OPENED: StructuredAgentSessionProviderOpenResult = {
  reportedOptions: { model: 'gpt-test' }
}

function awaitOpen() {
  const state = hostTestState()
  const acquire = state.acquire.getMockImplementation()
  if (!acquire) {
    throw new Error('The host fixture has no spawn implementation.')
  }
  state.host.deps.adapter.acquire = async (input) => ({
    ...(await acquire(input)),
    acquisitionGeneration: 'awaited-open'
  })
  const pending = Promise.withResolvers<StructuredAgentSessionProviderOpenResult>()
  const open = vi.fn<StructuredAgentSessionProviderOpen>(() => pending.promise)
  const close = vi.fn(async () => true)
  state.host.deps.adapter.open = open
  state.host.deps.adapter.closeSession = close
  const send = (text: string) => {
    const body = hostTestMessage(text)
    return state.host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  }
  return { ...state, open, close, pending, send }
}

it('cancels the open on quit after a second client attach is refused', async () => {
  const { host, open, close, dispatch, pending, send } = awaitOpen()
  await attach()
  await send('held')
  expect(await host.attach({ callerKey: 'second-client' }, attachParams())).toMatchObject({
    ok: false
  })
  const ended = host.flushAllStreamedEvents({ trigger: 'quit' })
  try {
    await vi.waitFor(() => expect(open.mock.calls[0]?.[0].signal.aborted).toBe(true))
    await ended
    expect(close).toHaveBeenCalledTimes(1)
    expect(dispatch).not.toHaveBeenCalled()
  } finally {
    pending.resolve(OPENED)
    await ended
  }
})

it('journals a typed writer refusal and cleans up the real starting child', async () => {
  const { host, open, close, dispatch, pending, send } = awaitOpen()
  await attach()
  await send('continue C')
  await vi.waitFor(() => expect(open).toHaveBeenCalledOnce())
  pending.reject(
    new AgentSessionAcquisitionRefusal(
      'thread C already has an active writer',
      'conversationOpenElsewhere'
    )
  )
  await vi.waitFor(async () => {
    const snapshot = await host.journalSnapshot(HOST_TEST_SESSION)
    expect(
      snapshot.submissions.some((entry) => entry.rejection?.kind === 'conversationOpenElsewhere')
    ).toBe(true)
  })
  expect(close).toHaveBeenCalledOnce()
  expect(dispatch).not.toHaveBeenCalled()
})
