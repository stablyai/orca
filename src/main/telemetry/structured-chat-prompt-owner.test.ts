import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcContext } from '../runtime/rpc/core'
import type { RpcCallerIdentity } from '../runtime/rpc/rpc-caller-identity'
import { structuredCallerFor } from '../runtime/rpc/methods/structured-sessions/creation/structured-agent-session-gate'
import type { StructuredChatTelemetryEvent } from '../../shared/structured-chat-dispatch-telemetry'
import { _setCommonPropsForTests } from './client'
import {
  BASE_COMMON,
  cleanupTelemetryClientTest,
  setupTelemetryClientTest,
  type TelemetryClientTestState
} from './client-test-harness'
import {
  recordRemoteStructuredChatTelemetry,
  recordStructuredChatPromptAccepted,
  subscribeStructuredChatTelemetry
} from './structured-chat-dispatch'

const HOST_INSTALL = '11111111-1111-4111-8111-111111111111'
const OWNER_INSTALL = '22222222-2222-4222-8222-222222222222'
let active: TelemetryClientTestState | undefined
let relayed: { event: StructuredChatTelemetryEvent; owner: string }[]
let unsubscribe: () => void

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-08T23:58:00Z'))
  relayed = []
  unsubscribe = subscribeStructuredChatTelemetry((event, owner) => relayed.push({ event, owner }))
})
afterEach(() => {
  unsubscribe()
  if (active) {
    cleanupTelemetryClientTest(active.envStash)
    active = undefined
  }
  vi.useRealTimers()
})

function desktop(installId: string, optedIn: boolean): TelemetryClientTestState {
  if (active) {
    cleanupTelemetryClientTest(active.envStash)
  }
  active = setupTelemetryClientTest({
    installId,
    optedIn,
    existedBeforeTelemetryRelease: false,
    protectedMilestones: { installCohort: 'fresh' }
  })
  _setCommonPropsForTests({ ...BASE_COMMON, install_id: installId })
  return active
}

function accept(
  caller: RpcCallerIdentity,
  clientKind?: 'mobile' | 'runtime',
  pairedDeviceParentId?: string
): void {
  const context: Partial<RpcContext> = { caller, clientKind, pairedDeviceParentId }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: caller derivation reads only the supplied transport identity fields.
  const identity = structuredCallerFor(context as RpcContext)
  if (!identity.userClient) {
    throw new Error('expected a transport-proven user')
  }
  recordStructuredChatPromptAccepted(
    { agent_kind: 'codex', runtime: 'unknown', client: identity.userClient },
    identity.telemetryOwnerKey
  )
}

const captured = (state: TelemetryClientTestState, name: string) =>
  state.mock.capture.mock.calls.map(([event]) => event).filter((event) => event.event === name)

it('lets the originating desktop opt in even when its initialized execution host opts out', () => {
  const host = desktop(HOST_INSTALL, false)
  accept({ kind: 'paired-device', deviceId: 'originating-desktop' }, 'runtime')
  expect(relayed).toEqual([
    {
      owner: 'originating-desktop',
      event: {
        type: 'structuredChatPromptAccepted',
        id: expect.any(String),
        agent_kind: 'codex',
        client: 'desktop'
      }
    }
  ])
  expect(host.settings.telemetry?.protectedMilestones).toEqual({ installCohort: 'fresh' })
  expect(host.mock.capture.mock.calls).toEqual([])

  const owner = desktop(OWNER_INSTALL, true)
  recordRemoteStructuredChatTelemetry(relayed[0].event)
  expect(owner.settings.telemetry?.protectedMilestones).toEqual({
    installCohort: 'fresh',
    firstAgentInteractionDay: 20_765,
    meaningfulActivityDay: 20_765
  })
  expect(captured(owner, 'first_agent_interaction')[0].properties).toMatchObject({
    install_id: OWNER_INSTALL,
    source: 'native_chat'
  })
  expect(captured(owner, 'meaningful_activity_day')[0].properties).toMatchObject({
    install_id: OWNER_INSTALL,
    trigger: 'native_chat'
  })
})

it('respects a delegated phone owners opt-out even when its initialized execution host opts in', () => {
  const host = desktop(HOST_INSTALL, true)
  accept({ kind: 'paired-device', deviceId: 'delegated-phone' }, 'mobile', 'originating-desktop')
  expect(relayed).toEqual([
    {
      owner: 'originating-desktop',
      event: {
        type: 'structuredChatPromptAccepted',
        id: expect.any(String),
        agent_kind: 'codex',
        client: 'mobile'
      }
    }
  ])
  expect(host.settings.telemetry?.protectedMilestones).toEqual({ installCohort: 'fresh' })
  expect(host.mock.capture.mock.calls).toEqual([])

  const owner = desktop(OWNER_INSTALL, false)
  recordRemoteStructuredChatTelemetry(relayed[0].event)
  expect(owner.settings.telemetry?.protectedMilestones).toEqual({ installCohort: 'fresh' })
  expect(owner.mock.capture.mock.calls).toEqual([])
})

it('keeps the local desktop and its directly paired phone on host installation consent', () => {
  const host = desktop(HOST_INSTALL, true)
  accept({ kind: 'desktop' })
  vi.setSystemTime(new Date('2026-11-09T00:01:00Z'))
  accept({ kind: 'paired-device', deviceId: 'direct-phone' }, 'mobile')
  expect(relayed).toEqual([])
  expect(host.settings.telemetry?.protectedMilestones).toEqual({
    installCohort: 'fresh',
    firstAgentInteractionDay: 20_765,
    meaningfulActivityDay: 20_766
  })
  expect(captured(host, 'first_agent_interaction')[0].properties).toMatchObject({
    install_id: HOST_INSTALL,
    source: 'native_chat'
  })
  expect(
    captured(host, 'meaningful_activity_day').map((event) => ({
      install_id: event.properties.install_id,
      trigger: event.properties.trigger
    }))
  ).toEqual([
    { install_id: HOST_INSTALL, trigger: 'native_chat' },
    { install_id: HOST_INSTALL, trigger: 'mobile_chat' }
  ])
})
