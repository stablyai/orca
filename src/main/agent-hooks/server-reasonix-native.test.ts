import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))
const capture = z
  .object({ events: z.array(z.record(z.string(), z.unknown())) })
  .parse(
    JSON.parse(
      readFileSync(
        join(
          __dirname,
          '../../shared/agent-hook-listener/providers/__fixtures__/reasonix-1-39-7-native-auth-rejection.hooks.json'
        ),
        'utf8'
      )
    )
  )
const id = '985b66b859ffae5cd8d17ef63ec3d33c'
let server: AgentHookServer
beforeEach(async () => {
  _internals.resetCachesForTests()
  server = new AgentHookServer()
  await server.start({ env: 'production' })
})
afterEach(() => server.stop())
async function post(payload: Record<string, unknown>, launchToken = 'native-launch') {
  expect(
    await postHookEvent(server, buildBody(payload, { launchToken }), '/hook/reasonix')
  ).toMatchObject({ status: 204 })
}
const event = (event: string, fields: Record<string, unknown> = {}) => ({
  event,
  sessionId: id,
  cwd: '/workspace',
  ...fields
})

it('routes newly captured native events through the canonical host store with turn identity and failure retained', async () => {
  await post(capture.events[0])
  await post(capture.events[1])
  const working = server.getStatusSnapshot()[0]
  expect(working).toMatchObject({
    paneKey: PANE,
    agentType: 'reasonix',
    state: 'working',
    providerSession: { key: 'session_id', id },
    observation: { origin: 'hook', boundary: true }
  })
  expect(server._getStateForTests().lastStatusByPaneKey.get(PANE)).toMatchObject({
    providerPromptId: `${id}:1`,
    promptInteractionKey: `reasonix-${id}-1`,
    hasExplicitPrompt: true
  })
  for (const payload of capture.events.slice(2)) {
    await post(payload)
  }
  const settled = server.getStatusSnapshot()[0]
  expect(settled).toMatchObject({
    state: 'done',
    agentType: 'reasonix',
    mainAgent: { state: 'done', outcome: 'failure' }
  })
  expect(settled.observation?.authorityId).toBe(working.observation?.authorityId)
  expect(settled.observation?.revision).toBeGreaterThan(working.observation?.revision ?? 0)
  expect(server.getProviderSessionIdentities()).toEqual([
    expect.objectContaining({ paneKey: PANE, sessionId: id })
  ])
})

it('rejects old-turn Stop and same-turn late tool updates without advancing accepted revisions', async () => {
  await post(event('UserPromptSubmit', { prompt: 'one', turn: 1 }))
  await post(event('UserPromptSubmit', { prompt: 'two', turn: 2 }))
  const before = server.getStatusSnapshot()[0]
  await post(event('StopFailure', { turn: 1, error: 'stale failure' }))
  expect(server.getStatusSnapshot()[0]).toEqual(before)
  await post(event('Stop', { turn: 2, isInterrupt: true }))
  const stopped = server.getStatusSnapshot()[0]
  expect(stopped).toMatchObject({
    state: 'done',
    interrupted: true,
    mainAgent: { outcome: 'cancellation' }
  })
  await post(event('PostToolUse', { turn: 2, toolName: 'read' }))
  expect(server.getStatusSnapshot()[0]).toEqual(stopped)
})

it('keeps retired launch and unrelated session guards around the Reasonix producer', async () => {
  await post(event('SessionStart', { source: 'startup' }), 'old-launch')
  await post(event('UserPromptSubmit', { prompt: 'old', turn: 1 }), 'old-launch')
  server.retirePaneAuthority(PANE)
  expect(server.getStatusSnapshot()).toEqual([])
  await post(event('Stop', { turn: 1 }), 'old-launch')
  expect(server.getStatusSnapshot()).toEqual([])
  await post(event('SessionStart', { source: 'startup', sessionId: 'fresh-id' }), 'fresh-launch')
  await post(
    event('UserPromptSubmit', { prompt: 'fresh', turn: 1, sessionId: 'fresh-id' }),
    'fresh-launch'
  )
  const fresh = server.getStatusSnapshot()[0]
  await post(event('Stop', { turn: 1 }), 'old-launch')
  await post(event('Stop', { turn: 1 }), 'fresh-launch')
  expect(server.getStatusSnapshot()[0]).toEqual(fresh)
  server.dropStatusEntriesByTabPrefix('tab-1')
  await post(event('SessionStart', { source: 'startup', sessionId: 'fresh-id' }), 'fresh-launch')
  expect(server.getStatusSnapshot()).toEqual([])
})
