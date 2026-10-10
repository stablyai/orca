import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import { AgentHookServer } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

const probe = vi.hoisted(() =>
  vi.fn(async (): Promise<'live' | 'unverifiable' | 'exited'> => 'live')
)
vi.mock('../../shared/agent-process-presence-probe', () => ({ probeAgentProcessPresence: probe }))

const servers: AgentHookServer[] = []
const paths: string[] = []
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
  for (const path of paths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
  probe.mockReset()
  probe.mockResolvedValue('live')
})

class OwnerTestServer extends AgentHookServer {
  /** Stands in for a hook transport that reports `nestedIn` (a later change wires the env markers). */
  applyHook(event: AgentHookEventPayload): void {
    this.applyNormalizedStatus(event)
  }
}

async function createServer(userDataPath?: string): Promise<OwnerTestServer> {
  const server = new OwnerTestServer()
  servers.push(server)
  await server.start({ env: 'production', ...(userDataPath ? { userDataPath } : {}) })
  return server
}

async function claude(
  server: AgentHookServer,
  event: string,
  extra: Record<string, unknown> = {},
  session = 'claude-a',
  pid: number | null = 4001
): Promise<void> {
  const agentProcess =
    pid === null
      ? undefined
      : JSON.stringify({ pid, platform: process.platform, startTime: `birth-${pid}` })
  const response = await postHookEvent(
    server,
    buildBody({ hook_event_name: event, session_id: session, ...extra }, { agentProcess })
  )
  expect(response.status).toBe(204)
}

async function codex(
  server: AgentHookServer,
  event: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  const response = await postHookEvent(
    server,
    buildBody({ hook_event_name: event, session_id: 'codex-x', model: 'gpt-6-astra', ...extra }),
    '/hook/codex'
  )
  expect(response.status).toBe(204)
}

function row(server: AgentHookServer) {
  return server.getStatusSnapshot().find((entry) => entry.paneKey === PANE)
}

describe('pane owner rule (local panes)', () => {
  it('keeps Claude the owner while a nested Codex reports into its pane (STA-9582)', async () => {
    const server = await createServer()
    const pushed: AgentHookEventPayload[] = []
    server.setListener((event) => pushed.push(event))
    await claude(server, 'UserPromptSubmit', { prompt: 'claude task' })
    await codex(server, 'UserPromptSubmit', { prompt: 'codex task' })
    await codex(server, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } })
    expect(row(server)).toMatchObject({
      state: 'working',
      agentType: 'claude',
      prompt: 'claude task',
      providerSession: { id: 'claude-a' }
    })
    await codex(server, 'Stop')
    await claude(server, 'Stop')
    // Prompt after Claude's Stop is the listener's pane-wide cache (a separate change), so not asserted.
    expect(row(server)).toMatchObject({
      state: 'done',
      agentType: 'claude',
      providerSession: { id: 'claude-a' }
    })
    expect(row(server)?.model).toBeUndefined()
    expect(pushed.length).toBeGreaterThan(0)
    for (const event of pushed) {
      expect(event.payload.agentType).toBe('claude')
      expect(event.payload.model).toBeUndefined()
      expect(event.providerSession?.id).toBe('claude-a')
    }
  })

  it('keeps an idle Claude the owner while its process lives, then takes its next turn', async () => {
    const server = await createServer()
    await claude(server, 'UserPromptSubmit', { prompt: 'first' })
    await claude(server, 'Stop')
    await codex(server, 'UserPromptSubmit', { prompt: 'detached codex' })
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce())
    expect(row(server)).toMatchObject({ state: 'done', agentType: 'claude' })
    await claude(server, 'UserPromptSubmit', { prompt: 'second' })
    expect(row(server)).toMatchObject({ state: 'working', agentType: 'claude', prompt: 'second' })
    await codex(server, 'Stop')
    expect(row(server)).toMatchObject({ state: 'working', agentType: 'claude' })
    await claude(server, 'Stop')
    expect(row(server)).toMatchObject({ state: 'done', agentType: 'claude' })
  })

  it('checks the owner once however many guest events arrive', async () => {
    const server = await createServer()
    await claude(server, 'UserPromptSubmit', { prompt: 'task' })
    for (let index = 0; index < 6; index += 1) {
      await codex(server, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } })
    }
    await vi.waitFor(() => expect(probe).toHaveBeenCalled())
    expect(probe).toHaveBeenCalledOnce()
  })

  it('hands the pane to the guest whose event proved the owner exited', async () => {
    const server = await createServer()
    await claude(server, 'UserPromptSubmit', { prompt: 'first' })
    await claude(server, 'Stop')
    probe.mockResolvedValue('exited')
    await codex(server, 'UserPromptSubmit', { prompt: 'codex task' })
    await vi.waitFor(() =>
      expect(row(server)).toMatchObject({
        state: 'working',
        agentType: 'codex',
        prompt: 'codex task',
        providerSession: { id: 'codex-x' }
      })
    )
  })

  it('never replays a guest onto an owner that ended on its own exit', async () => {
    const server = await createServer()
    let finish: (verdict: 'exited') => void = () => {}
    probe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    await claude(server, 'UserPromptSubmit', { prompt: 'claude task' })
    await codex(server, 'UserPromptSubmit', { prompt: 'codex task' })
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce())
    await claude(server, 'SessionEnd', { reason: 'prompt_input_exit' })
    finish('exited')
    await new Promise((resolve) => setTimeout(resolve, 20))
    const remnant = row(server)
    expect(remnant).toMatchObject({
      providerSessionOnly: true,
      agentType: 'claude',
      providerSession: { id: 'claude-a' }
    })
  })

  it('treats a same-type session without proof as the owner, but only its own exit ends it', async () => {
    const server = await createServer()
    await claude(server, 'UserPromptSubmit', { prompt: 'outer' })
    await claude(server, 'UserPromptSubmit', { prompt: 'inner' }, 'claude-b', 4002)
    expect(row(server)).toMatchObject({ agentType: 'claude', prompt: 'inner' })
    await claude(server, 'SessionEnd', { reason: 'other' }, 'claude-b', 4002)
    expect(row(server)?.providerSessionOnly).toBeUndefined()
    await claude(server, 'SessionEnd', { reason: 'other' })
    expect(row(server)?.providerSessionOnly).toBe(true)
  })

  // Why no process: an owner the host cannot check yields to liveness, so only proof keeps it here.
  it('keeps the owner session across /clear and recognizes the old one', async () => {
    const server = await createServer()
    await claude(server, 'UserPromptSubmit', { prompt: 'before clear' }, 'claude-a', null)
    await claude(server, 'SessionEnd', { reason: 'clear' }, 'claude-a', null)
    await claude(server, 'UserPromptSubmit', { prompt: 'after clear' }, 'claude-b', null)
    await claude(server, 'Stop', {}, 'claude-b', null)
    expect(row(server)).toMatchObject({ state: 'done', providerSession: { id: 'claude-b' } })
    server.applyHook({
      paneKey: PANE,
      connectionId: null,
      nestedIn: [{ agent: 'claude', session: 'claude-a' }],
      payload: { state: 'working', prompt: 'nested codex', agentType: 'codex' }
    })
    expect(row(server)).toMatchObject({ state: 'done', agentType: 'claude' })
  })

  const osc = (server: AgentHookServer, agentType: string, state: 'working' | 'done') =>
    server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      payload: { state, prompt: 'osc', agentType }
    })

  it("leaves a held owner's row unchanged when a terminal signal names another agent", async () => {
    const server = await createServer()
    await claude(server, 'UserPromptSubmit', { prompt: 'task' })
    const before = row(server)
    osc(server, 'codex', 'done')
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce())
    expect(row(server)).toEqual(before)
    expect(row(server)).toMatchObject({ state: 'working', agentType: 'claude', prompt: 'task' })
  })

  it('writes the next terminal signal once the check releases the owner', async () => {
    const server = await createServer()
    await claude(server, 'UserPromptSubmit', { prompt: 'task' })
    probe.mockResolvedValue('exited')
    osc(server, 'codex', 'working')
    await vi.waitFor(() => expect(row(server)?.providerSessionOnly).toBe(true))
    osc(server, 'codex', 'working')
    expect(row(server)).toMatchObject({ state: 'working', agentType: 'codex', prompt: 'osc' })
  })

  it("lets a terminal signal naming the owner's type update its state", async () => {
    const server = await createServer()
    await claude(server, 'UserPromptSubmit', { prompt: 'task' })
    osc(server, 'claude', 'done')
    expect(row(server)).toMatchObject({ state: 'done', agentType: 'claude' })
    expect(probe).not.toHaveBeenCalled()
  })

  it('hands the pane to a guest held while a terminal signal had already started the check', async () => {
    const server = await createServer()
    let finish: (verdict: 'exited') => void = () => {}
    probe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    await claude(server, 'UserPromptSubmit', { prompt: 'claude task' })
    osc(server, 'codex', 'working')
    await codex(server, 'UserPromptSubmit', { prompt: 'codex task' })
    expect(probe).toHaveBeenCalledOnce()
    finish('exited')
    await vi.waitFor(() =>
      expect(row(server)).toMatchObject({ agentType: 'codex', prompt: 'codex task' })
    )
  })

  it('leaves a released owner behind when a terminal signal names another agent', async () => {
    const server = await createServer()
    await codex(server, 'UserPromptSubmit', { prompt: 'codex task' })
    await codex(server, 'Stop')
    server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      connectionId: null,
      origin: 'process',
      payload: { state: 'working', prompt: '', agentType: 'opencode' }
    })
    expect(row(server)).toMatchObject({ state: 'working', agentType: 'opencode' })
    const response = await postHookEvent(
      server,
      buildBody({ hook_event_name: 'SessionBusy', sessionID: 'ses_1' }),
      '/hook/opencode'
    )
    expect(response.status).toBe(204)
    expect(row(server)).toMatchObject({ state: 'working', agentType: 'opencode' })
    expect(row(server)?.observation?.origin).toBe('hook')
    await codex(server, 'UserPromptSubmit', { prompt: 'late codex' })
    expect(row(server)).toMatchObject({ agentType: 'opencode' })
  })

  it("keeps the owner's agent type and model for signals that name no agent", async () => {
    const server = await createServer()
    await codex(server, 'UserPromptSubmit', { prompt: 'codex task' })
    expect(row(server)).toMatchObject({ agentType: 'codex', model: 'gpt-6-astra' })
    osc(server, 'unknown', 'working')
    expect(row(server)).toMatchObject({ agentType: 'codex', model: 'gpt-6-astra' })
    server.applyHook({
      paneKey: PANE,
      connectionId: null,
      providerSession: { key: 'session_id', id: 'codex-x' },
      payload: { state: 'done', prompt: 'codex task', agentType: 'unknown' }
    })
    expect(row(server)).toMatchObject({ state: 'done', agentType: 'codex', model: 'gpt-6-astra' })
  })

  it('never lets a terminal signal claim an ownerless pane', async () => {
    const server = await createServer()
    server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      payload: { state: 'working', prompt: 'osc', agentType: 'codex' }
    })
    expect(row(server)).toMatchObject({ agentType: 'codex' })
    await claude(server, 'UserPromptSubmit', { prompt: 'claude task' })
    expect(row(server)).toMatchObject({ agentType: 'claude', prompt: 'claude task' })
  })

  it('never inverts a restored owner when its nested producer reports first', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-pane-owner-'))
    paths.push(userDataPath)
    const first = await createServer(userDataPath)
    await claude(first, 'UserPromptSubmit', { prompt: 'claude task' })
    first.flushStatusPersistSync()
    first.stop()
    const restarted = await createServer(userDataPath)
    expect(row(restarted)).toMatchObject({ agentType: 'claude', restoredUnconfirmed: true })
    restarted.applyHook({
      paneKey: PANE,
      connectionId: null,
      nestedIn: [{ agent: 'claude', session: 'claude-a' }],
      payload: { state: 'working', prompt: 'nested codex', agentType: 'codex' }
    })
    expect(row(restarted)).toMatchObject({ agentType: 'claude', prompt: 'claude task' })
    await claude(restarted, 'Stop')
    expect(row(restarted)).toMatchObject({ state: 'done', agentType: 'claude' })
  })

  it('never lets a nested producer claim an ownerless pane', async () => {
    const server = await createServer()
    server.applyHook({
      paneKey: PANE,
      connectionId: null,
      nestedIn: [{ agent: 'claude', session: 'claude-a' }],
      payload: { state: 'working', prompt: 'nested codex', agentType: 'codex' }
    })
    expect(row(server)).toBeUndefined()
    await claude(server, 'UserPromptSubmit', { prompt: 'claude task' })
    expect(row(server)).toMatchObject({ agentType: 'claude' })
  })
})
