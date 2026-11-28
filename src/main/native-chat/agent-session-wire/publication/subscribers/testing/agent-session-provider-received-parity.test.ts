import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { AgentSessionSubscribeEvent } from '../../../../../../shared/agent-session/agent-session-wire'
import { claudeProviderHandle } from '../../../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import type { RpcContext } from '../../../../../runtime/rpc/core'
import type { AgentSessionSubscribeInput } from '../agent-session-subscribe-input'
import { STRUCTURED_AGENT_SESSION_SUBSCRIBE_METHOD } from '../../../../../runtime/rpc/methods/structured-sessions/subscriptions/structured-agent-session-subscribe-method'
import { AgentSessionSubscribers } from '../structured-agent-session-subscribers'
import {
  fixture,
  journals,
  SESSION
} from './structured-agent-session-subscriber-contract.test-fixture'

const { installed } = vi.hoisted(() => ({ installed: vi.fn() }))
vi.mock(
  '../../../../../runtime/rpc/methods/structured-sessions/creation/structured-agent-session-gate',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    requireInstalledStructuredHost: installed
  })
)

it('keeps remote and paired phone frames byte-identical when they ask for local receipts', async () => {
  const journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace',
      hostId: 'local',
      agent: 'claude',
      providerHandle: claudeProviderHandle('provider-1', null)
    },
    stateDirectory: join(fixture.root, SESSION)
  })
  const subscribers = new AgentSessionSubscribers({ now: () => 100 })
  const idle = async () => {
    await new Promise<void>((resolve) => setImmediate(resolve))
    await vi.waitFor(() => expect(subscribers.retention(new Set())).toEqual([]))
  }
  installed.mockResolvedValue({
    sessionAgent: () => 'claude',
    subscribe: (input: AgentSessionSubscribeInput) =>
      subscribers.open({ ...input, fence: 1, journal })
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stream uses only the registration callback.
  const runtime = {
    registerOwnedSubscriptionCleanup: () => ({ releaseIfCurrent: () => {} })
  } as unknown as RpcContext['runtime']
  const open = async (
    id: string,
    caller: RpcContext['caller'],
    clientKind: RpcContext['clientKind'],
    asks: boolean
  ) => {
    const frames: string[] = []
    const { params, handler } = STRUCTURED_AGENT_SESSION_SUBSCRIBE_METHOD
    await handler(
      params.parse({ sessionId: SESSION, capabilities: asks ? { providerReceived: 1 } : {} }),
      { runtime, caller, clientKind, connectionId: id },
      (frame) => frames.push(JSON.stringify(frame))
    )
    return frames
  }
  const paired = { kind: 'paired-device' as const, deviceId: 'paired-device' }
  const remote = await open('remote', paired, 'runtime', true)
  const remoteBaseline = await open('remote-baseline', paired, 'runtime', false)
  const phone = await open('phone', paired, 'mobile', true)
  const phoneBaseline = await open('phone-baseline', paired, 'mobile', false)
  const relay = await open('relay', paired, 'mobile', true)
  const desktop: AgentSessionSubscribeEvent[] = []
  let failedSends = 0
  subscribers.open({
    id: 'failed-desktop',
    sessionId: SESSION,
    journal,
    fence: 1,
    readsProviderReceived: true,
    emit: (event) => {
      if (event.type === 'batch' && event.providerReceived) {
        failedSends += 1
        throw new Error('receipt transport refused')
      }
      desktop.push(event)
    }
  })
  const receiving = await open('desktop', { kind: 'desktop' }, 'runtime', true)
  await idle()
  const receipt = subscribers.providerReceipts.bind({
    journal,
    clientMessageId: 'send',
    cursor: journal.cursor(),
    fence: 1,
    provider: 'claude',
    owns: () => true
  })
  receipt?.(() => true)
  await idle()
  expect(failedSends).toBe(1)
  expect(receiving.at(-1)).toContain('providerReceived')
  await journal.appendItem(
    { provider: 'orca', clientMessageId: 'later' },
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'still connected' }] },
    { fence: 1, turnScope: { kind: 'thread' } }
  )
  subscribers.deliverFrames(SESSION, journal)
  await idle()
  expect(JSON.stringify(desktop.at(-1))).toContain('still connected')
  expect(remote).toEqual(remoteBaseline)
  expect(phone).toEqual(phoneBaseline)
  expect(relay).toEqual(phoneBaseline)
})
