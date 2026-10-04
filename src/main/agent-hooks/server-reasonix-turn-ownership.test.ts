import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))
const id = '985b66b859ffae5cd8d17ef63ec3d33c'
let server: AgentHookServer
let userDataPath = ''
beforeEach(async () => {
  userDataPath = await mkdtemp(join(tmpdir(), 'reasonix-owner-'))
  server = new AgentHookServer()
  await server.start({ env: 'production', userDataPath })
})
afterEach(async () => {
  server.stop()
  await rm(userDataPath, { recursive: true, force: true })
})

async function post(event: string, turn: number, fields: Record<string, unknown> = {}) {
  await postHookEvent(
    server,
    buildBody(
      { event, turn, sessionId: id, cwd: '/workspace', ...fields },
      { launchToken: 'reasonix-owned-launch' }
    ),
    '/hook/reasonix'
  )
}

function relay(event: string, turn: number, state: 'working' | 'done' = 'working') {
  return {
    source: 'reasonix',
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    launchToken: 'reasonix-relay-launch',
    providerSession: { key: 'session_id', id },
    providerPromptId: `${id}:${turn}`,
    hookEventName: event,
    hasExplicitPrompt: event === 'UserPromptSubmit',
    payload: { agentType: 'reasonix', state, prompt: `Turn ${turn}` }
  }
}

it('retains the native turn across host restart without confirming restored work as live', async () => {
  await post('UserPromptSubmit', 2, { prompt: 'Second turn' })
  server.stop()
  server = new AgentHookServer()
  await server.start({ env: 'production', userDataPath })
  expect(server._getStateForTests().lastStatusByPaneKey.get(PANE)?.providerPromptId).toBe(`${id}:2`)
  const restored = server.getStatusSnapshot()[0]
  expect(restored).toMatchObject({ state: 'working', restoredUnconfirmed: true })
  await post('StopFailure', 1, { error: 'Old turn' })
  expect(server.getStatusSnapshot()[0]).toEqual(restored)
  await post('UserPromptSubmit', 3, { prompt: 'Third turn' })
  expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'working', prompt: 'Third turn' })
  expect(server.getStatusSnapshot()[0].restoredUnconfirmed).toBeUndefined()
})

it('keeps remote turn ordering, session identity and the settled revision at the receiver', () => {
  server.ingestRemote(relay('UserPromptSubmit', 2), 'ssh-reasonix')
  const working = server.getStatusSnapshot()[0]
  expect(server._getStateForTests().lastStatusByPaneKey.get(PANE)?.providerPromptId).toBe(`${id}:2`)
  server.ingestRemote(relay('StopFailure', 1, 'done'), 'ssh-reasonix')
  expect(server.getStatusSnapshot()[0]).toEqual(working)
  server.ingestRemote(
    { ...relay('Stop', 2, 'done'), providerSession: { key: 'session_id', id: 'unrelated' } },
    'ssh-reasonix'
  )
  expect(server.getStatusSnapshot()[0]).toEqual(working)
  server.ingestRemote(relay('Stop', 2, 'done'), 'ssh-reasonix')
  const done = server.getStatusSnapshot()[0]
  expect(done.state).toBe('done')
  server.ingestRemote(relay('PostToolUse', 2), 'ssh-reasonix')
  expect(server.getStatusSnapshot()[0]).toEqual(done)
})

it('rejects a remote tab identity mismatch before accepting its new prompt or revision', () => {
  server.ingestRemote(relay('UserPromptSubmit', 1), 'ssh-reasonix')
  const before = server.getStatusSnapshot()[0]
  server.ingestRemote({ ...relay('UserPromptSubmit', 2), tabId: 'another-tab' }, 'ssh-reasonix')
  expect(server.getStatusSnapshot()[0]).toEqual(before)
})
