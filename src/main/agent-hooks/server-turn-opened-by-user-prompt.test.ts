import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer, _internals } from './server'
import { buildBody, postHookEvent, PANE } from './server.test-fixtures'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

beforeEach(() => {
  _internals.resetCachesForTests()
  getCohortAtEmitMock.mockReturnValue({})
})

afterEach(() => {
  vi.restoreAllMocks()
})

const TASK_NOTIFICATION =
  '<task-notification><task-id>a1</task-id><status>completed</status></task-notification>'

// The execution host records who opened the main agent's turn, so a finish can be told apart: the
// reply to the user's own prompt, or a turn the agent woke itself for.
describe('the host-stamped turn opener', () => {
  const servers: AgentHookServer[] = []
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-turn-opened-by-user-prompt-'))
  })

  afterEach(() => {
    for (const server of servers) {
      server.stop()
    }
    servers.length = 0
    rmSync(userDataPath, { recursive: true, force: true })
  })

  async function startServer(): Promise<AgentHookServer> {
    const server = new AgentHookServer()
    servers.push(server)
    await server.start({ env: 'production', userDataPath })
    return server
  }

  async function post(server: AgentHookServer, payload: Record<string, unknown>): Promise<void> {
    const response = await postHookEvent(server, buildBody(payload))
    expect(response.status).toBe(204)
  }

  it('is unknown for a pane no hook reported', async () => {
    const server = await startServer()
    expect(server.isTurnOpenedByUserPrompt(PANE)).toBe(false)
  })

  it('holds from the user prompt through its tools to the finish', async () => {
    const server = await startServer()
    await post(server, { hook_event_name: 'UserPromptSubmit', prompt: 'Rename the module' })
    expect(server.isTurnOpenedByUserPrompt(PANE)).toBe(true)

    const bash = { tool_name: 'Bash', tool_input: { command: 'pnpm build' }, tool_use_id: 'tu-1' }
    await post(server, { hook_event_name: 'PreToolUse', ...bash })
    await post(server, { hook_event_name: 'PostToolUse', ...bash })
    await post(server, { hook_event_name: 'Stop' })
    expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'done' })
    expect(server.isTurnOpenedByUserPrompt(PANE)).toBe(true)
  })

  it('is dropped by a turn a task notification opened, through that turn finishing', async () => {
    const server = await startServer()
    await post(server, { hook_event_name: 'UserPromptSubmit', prompt: 'Rename the module' })
    await post(server, { hook_event_name: 'Stop' })

    await post(server, { hook_event_name: 'UserPromptSubmit', prompt: TASK_NOTIFICATION })
    expect(server.isTurnOpenedByUserPrompt(PANE)).toBe(false)
    await post(server, { hook_event_name: 'Stop' })
    expect(server.isTurnOpenedByUserPrompt(PANE)).toBe(false)

    await post(server, { hook_event_name: 'UserPromptSubmit', prompt: 'Now run the tests' })
    expect(server.isTurnOpenedByUserPrompt(PANE)).toBe(true)
  })

  it('is dropped when a finished main agent runs again with no turn-opening event', async () => {
    const server = await startServer()
    await post(server, { hook_event_name: 'UserPromptSubmit', prompt: 'Rename the module' })
    await post(server, { hook_event_name: 'Stop' })

    server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      payload: { state: 'working', prompt: 'Rename the module', agentType: 'claude' }
    })
    expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'working' })
    expect(server.isTurnOpenedByUserPrompt(PANE)).toBe(false)
  })

  it('is not touched by a child agent and clears on a session boundary', async () => {
    const server = await startServer()
    await post(server, { hook_event_name: 'UserPromptSubmit', prompt: TASK_NOTIFICATION })
    await post(server, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'child task',
      agent_id: 'child-1'
    })
    expect(server.isTurnOpenedByUserPrompt(PANE)).toBe(false)

    await post(server, { hook_event_name: 'UserPromptSubmit', prompt: 'Rename the module' })
    await post(server, { hook_event_name: 'SessionStart', source: 'clear' })
    expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'done', sessionBoundary: true })
    expect(server.isTurnOpenedByUserPrompt(PANE)).toBe(false)
  })

  it('cannot be declared by a producer', async () => {
    const server = await startServer()
    await post(server, {
      hook_event_name: 'UserPromptSubmit',
      prompt: TASK_NOTIFICATION,
      turnOpenedByUserPrompt: true
    })
    await post(server, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      turnOpenedByUserPrompt: true
    })
    expect(server.isTurnOpenedByUserPrompt(PANE)).toBe(false)
  })

  it('survives a restart through the status file', async () => {
    const server = await startServer()
    await post(server, { hook_event_name: 'UserPromptSubmit', prompt: 'Rename the module' })
    await post(server, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} })
    server.flushStatusPersistSync()
    server.stop()
    const file = JSON.parse(
      readFileSync(join(userDataPath, 'agent-hooks', 'last-status.json'), 'utf8')
    )
    expect(file.entries[PANE].turnOpenedByUserPrompt).toBe(true)

    const restarted = await startServer()
    expect(restarted.isTurnOpenedByUserPrompt(PANE)).toBe(true)
    await post(restarted, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {} })
    await post(restarted, { hook_event_name: 'Stop' })
    expect(restarted.isTurnOpenedByUserPrompt(PANE)).toBe(true)
  })
})
