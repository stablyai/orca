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

// Distinct host stamps: each event lands on a later millisecond than the one before it.
async function nextMillisecond(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5))
}

// The execution host stamps when the main agent's turn began, so every reader (and a reload, which
// starts the renderer with no state history) gets the turn start rather than rebuilding it.
describe('the host-stamped turn start', () => {
  const servers: AgentHookServer[] = []
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-turn-started-at-'))
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
    await nextMillisecond()
  }

  function turnStartedAt(server: AgentHookServer): number | undefined {
    return server.getStatusSnapshot()[0]?.turnStartedAt
  }

  it('stamps a new main-agent turn and carries it across tools, a wait and its answer', async () => {
    const server = await startServer()
    await post(server, { hook_event_name: 'UserPromptSubmit', prompt: 'Rename the module' })
    const started = turnStartedAt(server)
    expect(started).toBe(server.getStatusSnapshot()[0]?.stateStartedAt)

    const bash = { tool_name: 'Bash', tool_input: { command: 'pnpm build' }, tool_use_id: 'tu-1' }
    await post(server, { hook_event_name: 'PreToolUse', ...bash })
    await post(server, { hook_event_name: 'PermissionRequest', ...bash })
    expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'waiting' })
    await post(server, { hook_event_name: 'PostToolUse', ...bash })
    // The answer restarted the state clock, not the turn's.
    expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'working' })
    expect(server.getStatusSnapshot()[0]?.stateStartedAt).toBeGreaterThan(started!)
    expect(turnStartedAt(server)).toBe(started)

    await post(server, { hook_event_name: 'Stop' })
    // Kept on the finished turn, so a reader can time it from the host's own facts.
    expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'done', turnStartedAt: started })
  })

  it('is not stamped by a child agent, and the same prompt sent again is a new turn', async () => {
    const server = await startServer()
    await post(server, { hook_event_name: 'UserPromptSubmit', prompt: 'Rename the module' })
    const started = turnStartedAt(server)

    await post(server, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'child task',
      agent_id: 'child-1'
    })
    expect(turnStartedAt(server)).toBe(started)

    // Esc at a permission prompt fires no hook, so the resend follows the stale wait directly.
    await post(server, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} })
    await post(server, { hook_event_name: 'UserPromptSubmit', prompt: 'Rename the module' })
    expect(turnStartedAt(server)).toBeGreaterThan(started!)
  })

  it('is not stamped by a relayed replay', async () => {
    const server = await startServer()
    const envelope = {
      paneKey: PANE,
      tabId: 'tab-1',
      source: 'claude' as const,
      hookEventName: 'UserPromptSubmit',
      payload: { state: 'working' as const, prompt: 'relayed', agentType: 'claude' as const }
    }
    server.ingestRemote(envelope, 'ssh-turn')
    const started = turnStartedAt(server)
    expect(started).toEqual(expect.any(Number))
    await nextMillisecond()

    server.ingestRemote({ ...envelope, isReplay: true }, 'ssh-turn')
    expect(turnStartedAt(server)).toBe(started)
  })

  // A session start lands an idle boundary row: no turn is open until the next prompt.
  it('clears on a session boundary', async () => {
    const server = await startServer()
    await post(server, { hook_event_name: 'UserPromptSubmit', prompt: 'Rename the module' })
    expect(turnStartedAt(server)).toEqual(expect.any(Number))

    await post(server, { hook_event_name: 'SessionStart', source: 'clear' })
    expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'done', sessionBoundary: true })
    expect(server.getStatusSnapshot()[0]).not.toHaveProperty('turnStartedAt')
  })

  // An OSC repaint can land before the prompt hook; it must not count from the finished turn.
  it('drops the stamp when a finished main agent runs again with no turn-opening event', async () => {
    const server = await startServer()
    await post(server, { hook_event_name: 'UserPromptSubmit', prompt: 'Rename the module' })
    await post(server, { hook_event_name: 'Stop' })
    expect(turnStartedAt(server)).toEqual(expect.any(Number))

    server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      payload: { state: 'working', prompt: 'Rename the module', agentType: 'claude' }
    })
    expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'working' })
    expect(server.getStatusSnapshot()[0]).not.toHaveProperty('turnStartedAt')
  })

  it('cannot be declared by a producer', async () => {
    const server = await startServer()
    await post(server, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Rename the module',
      turnStartedAt: 1
    })
    await post(server, { hook_event_name: 'PreToolUse', tool_name: 'Bash', turnStartedAt: 1 })
    expect(turnStartedAt(server)).toBeGreaterThan(1)
  })

  it('reaches the live push and survives a restart through the status file', async () => {
    const server = await startServer()
    const pushed: (number | undefined)[] = []
    server.setListener((status) => pushed.push(status.turnStartedAt))
    await post(server, { hook_event_name: 'UserPromptSubmit', prompt: 'Rename the module' })
    await post(server, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} })
    const started = turnStartedAt(server)
    expect(pushed.at(-1)).toBe(started)
    server.flushStatusPersistSync()
    server.stop()
    const file = JSON.parse(
      readFileSync(join(userDataPath, 'agent-hooks', 'last-status.json'), 'utf8')
    )
    expect(file.entries[PANE].turnStartedAt).toBe(started)

    const restarted = await startServer()
    expect(restarted.getStatusSnapshot()[0]).toMatchObject({
      restoredUnconfirmed: true,
      turnStartedAt: started
    })
    // The turn goes on after the restart: the next event carries the restored stamp.
    await post(restarted, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {} })
    expect(turnStartedAt(restarted)).toBe(started)
  })
})
