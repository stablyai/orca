import {
  createRestTestRig,
  type RestTestRig
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-rest-test-rig'
import {
  createTestParams,
  CREATE_TEST_CALLER
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-create-test-fixture'
import {
  hostTestMessage,
  hostTestOperationId
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data'
import { afterEach, expect, it, vi } from 'vitest'
import {
  STRUCTURED_CHAT_DISPATCH_TELEMETRY_CLIENT_CAPABILITY,
  STRUCTURED_CHAT_START_TELEMETRY_CLIENT_CAPABILITY
} from '../../shared/structured-chat-dispatch-telemetry'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig.test-fixture'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { partialRuntimeStore } from '../runtime/orca-runtime-tests/runtime-store-partial-fixture'
import { CLIENT_EVENT_METHODS } from '../runtime/rpc/methods/client-events/client-events'
import { decodeRuntimeEnvironmentSubscriptionEvents } from '../ipc/runtime-environments/runtime-environment-subscription-events'
import { _enableTransportForTests } from './client'
import {
  BASE_COMMON,
  cleanupTelemetryClientTest,
  setupTelemetryClientTest,
  type TelemetryClientTestState
} from './client-test-harness'
import {
  recordRemoteStructuredChatTelemetry,
  recordStructuredChatMessageDispatch,
  recordStructuredChatAgentStart,
  subscribeStructuredChatTelemetry
} from './structured-chat-dispatch'

let restRig: RestTestRig | undefined
let desktop: TelemetryClientTestState | undefined
let rig: QueuedMessageTestRig | undefined
function isReadyMessage(frame: unknown): frame is { type: 'ready'; subscriptionId: string } {
  return (
    typeof frame === 'object' &&
    frame !== null &&
    'type' in frame &&
    frame.type === 'ready' &&
    'subscriptionId' in frame &&
    typeof frame.subscriptionId === 'string'
  )
}
afterEach(async () => {
  await restRig?.dispose()
  restRig = undefined
  await rig?.dispose()
  rig = undefined
  if (desktop) {
    cleanupTelemetryClientTest(desktop.envStash)
    desktop = undefined
  }
  _enableTransportForTests(false)
})

it('relays a committed Orcad send only to its caller and captures once using desktop consent', async () => {
  // Enable the build gate so the host must reject capture for its missing client lifecycle.
  _enableTransportForTests(true)
  const runtime = new OrcaRuntimeService(partialRuntimeStore())
  const frames: unknown[] = []
  const method = CLIENT_EVENT_METHODS.find(
    (entry) => entry.name === 'runtime.clientEvents.subscribe'
  )!
  const stream = method.handler(
    {},
    {
      runtime,
      clientId: 'client-1',
      caller: { kind: 'paired-device', deviceId: 'client-1' },
      connectionId: 'remote-telemetry',
      clientKind: 'runtime',
      clientCapabilities: [STRUCTURED_CHAT_DISPATCH_TELEMETRY_CLIENT_CAPABILITY]
    },
    (event) => frames.push(event)
  )
  const ready = frames.find(isReadyMessage)!
  const otherFrames: unknown[] = []
  const otherStream = method.handler(
    {},
    {
      runtime,
      clientId: 'another-desktop',
      caller: { kind: 'paired-device', deviceId: 'another-desktop' },
      connectionId: 'other-telemetry',
      clientKind: 'runtime',
      clientCapabilities: [STRUCTURED_CHAT_DISPATCH_TELEMETRY_CLIENT_CAPABILITY]
    },
    (event) => otherFrames.push(event)
  )
  const otherReady = otherFrames.find(isReadyMessage)!
  try {
    rig = await createQueuedMessageTestRig()
    const messageId = await rig.workingSend()
    expect(frames).toHaveLength(1)
    await rig.settleAccepted(messageId, 'remote-item')
    await rig.settleAccepted(messageId, 'remote-item')
    expect(otherFrames).toHaveLength(1)
    expect(frames).toEqual([
      expect.objectContaining({ type: 'ready' }),
      {
        type: 'structuredChatMessageDispatch',
        id: expect.any(String),
        agent_kind: 'codex',
        outcome: 'transport_acknowledged'
      }
    ])
    desktop = setupTelemetryClientTest()
    const rendererFrames: unknown[] = []
    const receive = decodeRuntimeEnvironmentSubscriptionEvents(
      'runtime.clientEvents.subscribe',
      (frame) => rendererFrames.push(frame),
      () => true
    )
    const delivery = {
      type: 'response' as const,
      response: {
        id: 'remote-events',
        ok: true as const,
        result: frames[1],
        _meta: { runtimeId: 'remote-orcad' }
      }
    }
    receive(delivery)
    receive(delivery)
    expect(rendererFrames).toEqual([])
    expect(desktop.mock.capture.mock.calls).toEqual([
      [
        {
          distinctId: '00000000-0000-4000-8000-000000000000',
          event: 'native_chat_message_sent',
          properties: {
            ...BASE_COMMON,
            $process_person_profile: false,
            semantics_version: 2,
            client: 'desktop',
            backend: 'structured',
            action: 'message',
            outcome: 'transport_acknowledged',
            agent_kind: 'codex',
            runtime: 'remote'
          }
        }
      ]
    ])
  } finally {
    runtime.cleanupSubscription(ready.subscriptionId)
    runtime.cleanupSubscription(otherReady.subscriptionId)
    await Promise.all([stream, otherStream])
  }
})

it('does not relay around initialized desktop opt-out or capture remote outcomes after opt-out', () => {
  desktop = setupTelemetryClientTest({
    optedIn: false,
    installId: BASE_COMMON.install_id,
    existedBeforeTelemetryRelease: false
  })
  const relayed: unknown[] = []
  const unsubscribe = subscribeStructuredChatTelemetry((event) => relayed.push(event))
  try {
    recordStructuredChatMessageDispatch(
      {
        sessionId: 'local-chat',
        workspaceId: 'folder-1',
        hostId: 'local',
        agent: 'claude',
        providerHandle: null
      },
      'accepted',
      () => 'client-1'
    )
    recordRemoteStructuredChatTelemetry({
      type: 'structuredChatMessageDispatch',
      id: '00000000-0000-4000-8000-000000000001',
      agent_kind: 'claude-code',
      outcome: 'transport_acknowledged'
    })
    recordStructuredChatAgentStart(
      { agent_kind: 'codex', launch_source: 'unknown', request_kind: 'resume' },
      () => 'client-1'
    )
    recordRemoteStructuredChatTelemetry({
      type: 'structuredChatAgentStart',
      id: '00000000-0000-4000-8000-000000000002',
      agent_kind: 'codex',
      launch_source: 'unknown',
      request_kind: 'resume'
    })
    expect(relayed).toEqual([])
    expect(desktop.mock.capture.mock.calls).toEqual([])
  } finally {
    unsubscribe()
  }
})

it('relays a remote create opening dispatch and proved start through desktop capture once', async () => {
  _enableTransportForTests(true)
  const runtime = new OrcaRuntimeService(partialRuntimeStore())
  const frames: unknown[] = []
  const method = CLIENT_EVENT_METHODS.find(
    (entry) => entry.name === 'runtime.clientEvents.subscribe'
  )!
  const stream = method.handler(
    {},
    {
      runtime,
      clientId: 'client-1',
      caller: { kind: 'paired-device', deviceId: 'client-1' },
      connectionId: 'remote-create-telemetry',
      clientKind: 'runtime',
      clientCapabilities: [
        STRUCTURED_CHAT_DISPATCH_TELEMETRY_CLIENT_CAPABILITY,
        STRUCTURED_CHAT_START_TELEMETRY_CLIENT_CAPABILITY
      ]
    },
    (event) => frames.push(event)
  )
  const ready = frames.find(isReadyMessage)!
  try {
    restRig = await createRestTestRig()
    const firstMessage = {
      clientMessageId: hostTestOperationId(),
      body: hostTestMessage('opening work')
    }
    const params = createTestParams(firstMessage)
    expect(await restRig.host.create(CREATE_TEST_CALLER, params, { firstMessage })).toMatchObject({
      ok: true
    })
    await vi.waitFor(() => expect(frames).toHaveLength(3))
    expect(frames.slice(1)).toEqual([
      {
        type: 'structuredChatAgentStart',
        id: expect.any(String),
        agent_kind: 'codex',
        launch_source: 'unknown',
        request_kind: 'new'
      },
      {
        type: 'structuredChatMessageDispatch',
        id: expect.any(String),
        agent_kind: 'codex',
        outcome: 'transport_acknowledged'
      }
    ])
    expect(await restRig.host.create(CREATE_TEST_CALLER, params, { firstMessage })).toMatchObject({
      ok: true,
      replayed: true
    })
    desktop = setupTelemetryClientTest()
    const rendererFrames: unknown[] = []
    const receive = decodeRuntimeEnvironmentSubscriptionEvents(
      'runtime.clientEvents.subscribe',
      (frame) => rendererFrames.push(frame),
      () => true
    )
    for (const event of frames.slice(1)) {
      const delivery = {
        type: 'response' as const,
        response: {
          id: 'create-events',
          ok: true as const,
          result: event,
          _meta: { runtimeId: 'remote-orcad' }
        }
      }
      receive(delivery)
      receive(delivery)
    }
    expect(rendererFrames).toEqual([])
    expect(
      desktop.mock.capture.mock.calls.map(([capture]) => ({
        event: capture.event,
        backend: capture.properties.backend,
        request_kind: capture.properties.request_kind
      }))
    ).toEqual([
      { event: 'agent_started', backend: 'structured', request_kind: 'new' },
      { event: 'native_chat_message_sent', backend: 'structured', request_kind: undefined }
    ])
  } finally {
    runtime.cleanupSubscription(ready.subscriptionId)
    await stream
  }
})
