// A transcript stream ends when its client says so: the host drops that subscriber, so nothing is
// derived or sent for it any more, and a sibling stream of the same session keeps going.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  createRestTestRig,
  foundRestTestChat,
  REST_TEST_CALLER as CALLER,
  REST_TEST_SESSION as SESSION,
  restTestSend,
  type RestTestRig
} from '../../../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcResponse } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { STRUCTURED_AGENT_SESSION_METHODS } from './structured-agent-session'

const CLIENT = {
  clientId: 'device-1',
  clientKind: 'runtime' as const,
  clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY],
  connectionId: 'connection-1'
}

let rig: RestTestRig
let dispatcher: RpcDispatcher

function subscriberCount(): number {
  const delivery: unknown = Reflect.get(rig.host, 'clientDelivery')
  const subscribers: unknown =
    typeof delivery === 'object' && delivery !== null ? Reflect.get(delivery, 'subscribers') : null
  const bySession: unknown =
    typeof subscribers === 'object' && subscribers !== null
      ? Reflect.get(subscribers, 'bySession')
      : null
  return bySession instanceof Map ? (bySession.get(SESSION)?.size ?? 0) : -1
}

async function stream(id: string, frames: RpcResponse[]): Promise<void> {
  await dispatcher.dispatchStreaming(
    { id, authToken: 'token', method: 'agentSession.subscribe', params: { sessionId: SESSION } },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatcher writes RpcResponse JSON.
    (raw) => frames.push(JSON.parse(raw) as RpcResponse),
    CLIENT
  )
}

beforeEach(async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 3_600_000 } })
  setStructuredAgentSessionHost(rig.host)
  const runtime = new OrcaRuntimeService()
  vi.spyOn(runtime, 'getClientSettings').mockImplementation(
    () =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the RPC gate reads only this one setting.
      ({ experimentalStructuredNativeChat: true }) as ReturnType<
        OrcaRuntimeService['getClientSettings']
      >
  )
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatcher writes RpcResponse JSON.
    (raw) => replies.push(JSON.parse(raw) as RpcResponse),
    CLIENT
  )
  expect(replies[0]).toMatchObject({ ok: true })
  expect(subscriberCount()).toBe(1)

  const before = ended.length
  const fence = rig.store.getRecord(SESSION)!.lease.runtimeFence
  await rig.host.send(CALLER, restTestSend('after the unsubscribe', fence))
  await vi.waitFor(() => expect(kept.length).toBeGreaterThan(1))
  // The ended stream's own `end` frame is all it gets.
  expect(ended.slice(before).every((frame) => JSON.stringify(frame).includes('"end"'))).toBe(true)
})
