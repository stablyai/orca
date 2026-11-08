import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { subscribeStructuredChatTelemetry } from '../../telemetry/structured-chat-dispatch'
import type { StructuredChatTelemetryEvent } from '../../../shared/structured-chat-dispatch-telemetry'
import { CALLER, hostTestState } from './host/testing/structured-agent-session-host-test-harness'
import { createTestParams } from './host/testing/structured-agent-session-create-test-fixture'
import {
  HOST_TEST_SESSION,
  hostTestMessage,
  hostTestOperationId,
  hostTestSendParams
} from './host/testing/structured-agent-session-host-test-data'
import { createQueuedMessageTestRig } from './host/testing/structured-agent-session-queued-message-rig.test-fixture'

vi.mock('../../telemetry/client', () => ({
  track: () => false,
  isTelemetryInitialized: () => false
}))

let events: { event: StructuredChatTelemetryEvent; callerKey: string }[]
let unsubscribe: () => void

beforeEach(() => {
  events = []
  unsubscribe = subscribeStructuredChatTelemetry((event, callerKey) =>
    events.push({ event, callerKey })
  )
})

afterEach(() => unsubscribe())

it('relays a delivery start for a remote create with an opening message to its desktop', async () => {
  const { host } = hostTestState()
  const firstMessage = {
    clientMessageId: hostTestOperationId(),
    body: hostTestMessage('Opening message')
  }
  expect(await host.create(CALLER, createTestParams(firstMessage), { firstMessage })).toMatchObject(
    {
      ok: true
    }
  )

  await vi.waitFor(() =>
    expect(events).toEqual([
      {
        callerKey: 'client-1',
        event: {
          type: 'structuredChatAgentStart',
          id: expect.any(String),
          agent_kind: 'codex',
          launch_source: 'unknown',
          request_kind: 'new'
        }
      }
    ])
  )
})

it('relays a send that starts a resting chat to the sender rather than its creator', async () => {
  const { host } = hostTestState()
  expect(await host.create({ callerKey: 'client-2' }, createTestParams())).toMatchObject({
    ok: true
  })
  expect(await host.send(CALLER, hostTestSendParams('Start this resting chat'))).toMatchObject({
    ok: true
  })

  await vi.waitFor(() =>
    expect(events).toEqual([
      {
        callerKey: 'client-1',
        event: {
          type: 'structuredChatAgentStart',
          id: expect.any(String),
          agent_kind: 'codex',
          launch_source: 'unknown',
          request_kind: 'new'
        }
      }
    ])
  )
})

it('attributes an automatic queue handoff start to the desktop that enqueued it', async () => {
  const rig = await createQueuedMessageTestRig({ restartable: true })
  try {
    const working = await rig.workingSend()
    const fields = { body: hostTestMessage('Queued message'), delivery: 'queue-if-active' as const }
    expect(
      await rig.host.send(
        { callerKey: 'client-2' },
        {
          envelope: rig.envelope(fields, 'agentSession.send', hostTestOperationId()),
          ...fields,
          userSend: true
        }
      )
    ).toMatchObject({ ok: true, value: { queued: expect.anything() } })
    events = []
    rig.host.deps.adapter.requiresModelTransitionRestart = vi.fn().mockReturnValueOnce(true)
    await rig.settleAccepted(working, 'finished')

    await vi.waitFor(() =>
      expect(events).toEqual([
        {
          callerKey: 'client-2',
          event: expect.objectContaining({
            type: 'structuredChatAgentStart',
            request_kind: 'resume'
          })
        }
      ])
    )
  } finally {
    await rig.dispose()
  }
})

it('attributes an explicit queued Send start to the sending desktop', async () => {
  const rig = await createQueuedMessageTestRig({ restartable: true })
  try {
    await rig.workingSend()
    const queued = rig.send('Queued message', 'queue-if-active')
    expect(await queued.result).toMatchObject({ ok: true, value: { queued: expect.anything() } })
    await rig.host.close(HOST_TEST_SESSION, 'evict')
    events = []
    const fields = { messageId: queued.id }
    expect(
      await rig.host.queuedMessageSend(
        { callerKey: 'client-2' },
        {
          envelope: rig.envelope(fields, 'agentSession.queuedMessageSend', hostTestOperationId()),
          ...fields
        }
      )
    ).toMatchObject({ ok: true })

    await vi.waitFor(() =>
      expect(events).toEqual([
        {
          callerKey: 'client-2',
          event: expect.objectContaining({
            type: 'structuredChatAgentStart',
            request_kind: 'resume'
          })
        }
      ])
    )
  } finally {
    await rig.dispose()
  }
})
