import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { decodeRuntimeEnvironmentSubscriptionEvents } from './runtime-environment-subscription-events'
import {
  cleanupTelemetryClientTest,
  setupTelemetryClientTest,
  type TelemetryClientTestState
} from '../../telemetry/client-test-harness'

let state: TelemetryClientTestState
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-08T23:58:00Z'))
  state = setupTelemetryClientTest({
    optedIn: true,
    installId: '00000000-0000-4000-8000-000000000000',
    existedBeforeTelemetryRelease: false,
    protectedMilestones: { installCohort: 'fresh' }
  })
})
afterEach(() => {
  cleanupTelemetryClientTest(state.envStash)
  vi.useRealTimers()
})

const prompt = (client: 'desktop' | 'mobile' = 'desktop') => ({
  type: 'structuredChatPromptAccepted',
  id: randomUUID(),
  agent_kind: 'codex',
  client
})
const frame = (result: unknown) => ({
  type: 'response' as const,
  response: { id: 'events-1', ok: true as const, result, _meta: { runtimeId: 'remote-runtime' } }
})
const cursor = () => state.settings.telemetry?.protectedMilestones
const captured = (name: string) =>
  state.mock.capture.mock.calls.map(([event]) => event).filter((event) => event.event === name)

it('consumes live accepted observations in desktop main once, without exposing their IDs to analytics', () => {
  const delivered: unknown[] = []
  let current = false
  const observe = decodeRuntimeEnvironmentSubscriptionEvents(
    'runtime.clientEvents.subscribe',
    (event) => delivered.push(event),
    () => current
  )
  const event = prompt()
  observe(frame(event))
  expect(cursor()).toEqual({ installCohort: 'fresh' })
  current = true
  observe(frame(event))
  expect(cursor()).toEqual({
    installCohort: 'fresh',
    firstAgentInteractionDay: 20_765,
    meaningfulActivityDay: 20_765
  })
  expect(captured('first_agent_interaction')[0].properties).toMatchObject({
    source: 'native_chat',
    agent_kind: 'codex'
  })
  expect(captured('meaningful_activity_day')[0].properties.trigger).toBe('native_chat')
  expect(delivered).toEqual([frame(event)])
  expect(JSON.stringify(state.mock.capture.mock.calls)).not.toContain(event.id)

  vi.setSystemTime(new Date('2026-11-09T00:01:00Z'))
  observe(frame(event))
  expect(cursor()?.meaningfulActivityDay).toBe(20_765)
  observe(frame(prompt('mobile')))
  expect(cursor()?.meaningfulActivityDay).toBe(20_766)
  expect(captured('meaningful_activity_day').map((entry) => entry.properties.trigger)).toEqual([
    'native_chat',
    'mobile_chat'
  ])
})

it('drops opted-out observations permanently and rejects unbounded or content-bearing facts', () => {
  const observe = decodeRuntimeEnvironmentSubscriptionEvents(
    'runtime.clientEvents.subscribe',
    () => {},
    () => true
  )
  const event = prompt('mobile')
  state.settings.telemetry!.optedIn = false
  observe(frame(event))
  expect(cursor()).toEqual({ installCohort: 'fresh' })
  state.settings.telemetry!.optedIn = true
  observe(frame(event))
  observe(frame({ ...prompt(), body: 'private prompt must never reach analytics' }))
  observe(frame({ ...prompt(), agent_kind: 'arbitrary-agent-name' }))
  const wrongMethod = decodeRuntimeEnvironmentSubscriptionEvents(
    'agentSession.subscribe',
    () => {},
    () => true
  )
  wrongMethod(frame(prompt()))
  expect(cursor()).toEqual({ installCohort: 'fresh' })

  observe(frame(prompt('mobile')))
  expect(cursor()).toEqual({
    installCohort: 'fresh',
    firstAgentInteractionDay: 20_765,
    meaningfulActivityDay: 20_765
  })
  expect(captured('first_agent_interaction')[0].properties.source).toBe('mobile_chat')
})
