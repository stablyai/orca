// Unsubscribe stops only that transcript's projection/sends; sibling streams continue.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../../../shared/agent-session/agent-session-runtime-capabilities'
import { setStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import {
  createRestTestRig,
  foundRestTestChat,
  REST_TEST_CALLER as CALLER,
  restTestSend
} from '../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-rest-test-rig.test-fixture'

import { HOST_TEST_SESSION as SESSION } from '../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import type { RestTestRig } from '../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-rest-test-rig.test-fixture'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import type { RpcResponse } from '../../../core'
import { RpcDispatcher } from '../../../dispatcher'
import { STRUCTURED_AGENT_SESSION_METHODS } from '../structured-agent-session'

const CLIENT = {
  clientId: 'device-1',
  clientKind: 'runtime' as const,
  clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY],
  connectionId: 'connection-1'
}

let rig: RestTestRig
let dispatcher: RpcDispatcher

function subscriberCount(): number {
  return rig.host.collaboratorsForTests().subscribers.subscriberCountForTests(SESSION)
}

async function stream(id: string, frames: RpcResponse[]): Promise<void> {
  await dispatcher.dispatchStreaming(
    { id, authToken: 'token', method: 'agentSession.subscribe', params: { sessionId: SESSION } },
    (raw) => frames.push(JSON.parse(raw)),
    CLIENT
  )
}

beforeEach(async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 3_600_000 } })
  setStructuredAgentSessionHost(rig.host)
  const runtime = new OrcaRuntimeService()

  dispatcher = new RpcDispatcher({ runtime, methods: STRUCTURED_AGENT_SESSION_METHODS })
})

afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig.dispose()
})

it('drops the subscriber a client unsubscribes, and keeps its sibling (U-02)', async () => {
  await foundRestTestChat(rig)
  const ended: RpcResponse[] = []
  const kept: RpcResponse[] = []
  await stream('frame-a', ended)
  await stream('frame-b', kept)
  expect(subscriberCount()).toBe(2)

  const replies: RpcResponse[] = []
  await dispatcher.dispatchStreaming(
    {
      id: 'frame-c',
      authToken: 'token',
      method: 'agentSession.unsubscribe',
      params: { sessionId: SESSION, subscriptionId: 'frame-a' }
    },
    (raw) => replies.push(JSON.parse(raw)),
    CLIENT
  )
  expect(replies[0]).toMatchObject({ ok: true })
  expect(subscriberCount()).toBe(1)

  const before = ended.length
  const fence = rig.store.getRecord(SESSION)!.lease.runtimeFence
  await rig.host.send(CALLER, restTestSend('after the unsubscribe', fence))
  await vi.waitFor(() => expect(kept.length).toBeGreaterThan(1))
  expect(ended.slice(before).every((frame) => JSON.stringify(frame).includes('"end"'))).toBe(true)
})

// #39926: a frame the transport fails to send must end the stream, never leave it open and silent.
// An opening snapshot can be superseded by live work; either first data frame can fail.
it('ends the stream once when an opening frame fails to send', async () => {
  await foundRestTestChat(rig)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const frames: RpcResponse[] = []
  const ended = Promise.withResolvers<void>()
  await dispatcher.dispatchStreaming(
    {
      id: 'frame-a',
      authToken: 'token',
      method: 'agentSession.subscribe',
      params: { sessionId: SESSION }
    },
    (raw) => {
      if (!raw.includes('"type":"end"')) {
        throw new Error('frame could not be sent')
      }
      frames.push(JSON.parse(raw))
      if (raw.includes('"type":"end"')) {
        ended.resolve()
      }
    },
    CLIENT
  )

  await ended.promise
  expect(subscriberCount()).toBe(0)
  expect(frames.map((frame) => JSON.stringify(frame).match(/"type":"(\w+)"/)?.[1])).toEqual(['end'])

  // Later publications reach no one and end nothing twice.
  const fence = rig.store.getRecord(SESSION)!.lease.runtimeFence
  await rig.host.send(CALLER, restTestSend('after the failed frame', fence))
  expect(frames.filter((frame) => JSON.stringify(frame).includes('"type":"end"'))).toHaveLength(1)
})
