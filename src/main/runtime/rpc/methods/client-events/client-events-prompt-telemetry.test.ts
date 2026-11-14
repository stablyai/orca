import { expect, it } from 'vitest'
import {
  STRUCTURED_CHAT_PROMPT_TELEMETRY_CLIENT_CAPABILITY,
  STRUCTURED_CHAT_START_TELEMETRY_CLIENT_CAPABILITY
} from '../../../../../shared/structured-chat-dispatch-telemetry'
import { recordStructuredChatPromptAccepted } from '../../../../telemetry/structured-chat-dispatch'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { eraseRpcMethods, isStreamingMethod, type RpcContext } from '../../core'
// Import the registry to avoid client-events' module-init cycle through ipc/ssh.
import { ALL_RPC_METHODS } from '../rpc-method-registry'

const subscribe = eraseRpcMethods(ALL_RPC_METHODS)
  .filter(isStreamingMethod)
  .find((method) => method.name === 'runtime.clientEvents.subscribe')!

function open(overrides: Partial<RpcContext> = {}) {
  const events: unknown[] = []
  let cleanup = () => {}
  const fake = {
    onClientEvent: () => () => {},
    getClientSettings: () => ({}),
    registerSubscriptionCleanup: (_id: string, close: () => void) => {
      cleanup = close
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stream reads only these runtime members.
  const runtime = fake as unknown as OrcaRuntimeService
  const done = subscribe.handler(
    {},
    {
      runtime,
      caller: { kind: 'paired-device', deviceId: 'desktop-a' },
      pairedDeviceId: 'desktop-a',
      clientKind: 'runtime',
      clientCapabilities: [STRUCTURED_CHAT_PROMPT_TELEMETRY_CLIENT_CAPABILITY],
      ...overrides
    },
    (event) => {
      if (
        typeof event === 'object' &&
        event !== null &&
        'type' in event &&
        event.type === 'structuredChatPromptAccepted'
      ) {
        events.push(event)
      }
    }
  )
  return { events, done, close: () => cleanup() }
}

it('addresses live observations only to capable authenticated owning desktops, with no reconnect backfill', async () => {
  const owner = open()
  const other = open({
    caller: { kind: 'paired-device', deviceId: 'desktop-b' },
    pairedDeviceId: 'desktop-b'
  })
  const old = open({ clientCapabilities: [STRUCTURED_CHAT_START_TELEMETRY_CLIENT_CAPABILITY] })
  const phone = open({ clientKind: 'mobile' })
  const unproven = open({ caller: undefined, clientId: 'desktop-a' })
  const cli = open({ caller: { kind: 'local-cli' }, clientId: 'desktop-a' })
  const streams = [owner, other, old, phone, unproven, cli]
  let reconnected: ReturnType<typeof open> | undefined
  try {
    recordStructuredChatPromptAccepted(
      { agent_kind: 'codex', client: 'mobile', runtime: 'unknown' },
      'desktop-a'
    )
    expect(owner.events).toEqual([
      {
        type: 'structuredChatPromptAccepted',
        id: expect.any(String),
        agent_kind: 'codex',
        client: 'mobile'
      }
    ])
    expect([other.events, old.events, phone.events, unproven.events, cli.events]).toEqual([
      [],
      [],
      [],
      [],
      []
    ])

    owner.close()
    await owner.done
    recordStructuredChatPromptAccepted(
      { agent_kind: 'codex', client: 'desktop', runtime: 'unknown' },
      'desktop-a'
    )
    reconnected = open()
    expect(reconnected.events).toEqual([])
    recordStructuredChatPromptAccepted(
      { agent_kind: 'claude-code', client: 'desktop', runtime: 'unknown' },
      'desktop-a'
    )
    expect(reconnected.events).toEqual([
      {
        type: 'structuredChatPromptAccepted',
        id: expect.any(String),
        agent_kind: 'claude-code',
        client: 'desktop'
      }
    ])
    expect(owner.events).toHaveLength(1)
  } finally {
    for (const stream of [...streams, ...(reconnected ? [reconnected] : [])]) {
      stream.close()
      await stream.done
    }
  }
})
