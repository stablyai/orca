import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer, type Server as NetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
vi.mock('../../shared/agent-process-presence-probe', () => ({
  probeAgentProcessPresence: vi.fn(async () => 'unverifiable')
}))

const OWNER_PROCESS = { pid: 4001, platform: process.platform, startTime: 'birth-4001' }
const servers: AgentHookServer[] = []
const temporaryPaths: string[] = []

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

async function startServer(options: { userDataPath?: string; reuseEndpoint?: boolean } = {}) {
  const server = new AgentHookServer()
  servers.push(server)
  await server.start({ env: 'production', ...options })
  return server
}

function userDataPath(): string {
  const path = mkdtempSync(join(tmpdir(), 'orca-http-hook-endpoint-'))
  temporaryPaths.push(path)
  return path
}

async function startOwnerTurn(server: AgentHookServer, session = 'session-a'): Promise<void> {
  const response = await postHookEvent(
    server,
    buildBody(
      { hook_event_name: 'UserPromptSubmit', session_id: session, prompt: 'owner task' },
      { agentProcess: JSON.stringify(OWNER_PROCESS) }
    )
  )
  expect(response.status).toBe(204)
}

// Mirrors what Claude Code sends for a managed http entry: raw event JSON, plain x-orca-* headers.
function postHttpHook(
  server: AgentHookServer,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {}
): Promise<Response> {
  const env = server.buildPtyEnv()
  return fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude?orca-hook=claude-hook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN,
      'X-Orca-Pane-Key': PANE,
      'X-Orca-Tab-Id': 'tab-1',
      'X-Orca-Agent-Hook-Env': 'production',
      'X-Orca-Agent-Hook-Version': env.ORCA_AGENT_HOOK_VERSION,
      ...headers
    },
    body: JSON.stringify(payload)
  })
}

function ownerRow(server: AgentHookServer) {
  return server._getStateForTests().lastStatusByPaneKey.get(PANE)
}

const readTool = { hook_event_name: 'PreToolUse', session_id: 'session-a', tool_name: 'Read' }

describe('Claude http tool hooks', () => {
  it('applies a tool event to the owning session and keeps its process and worktree', async () => {
    const server = await startServer()
    await startOwnerTurn(server)

    const response = await postHttpHook(server, readTool)

    expect(response.status).toBe(204)
    expect(ownerRow(server)).toMatchObject({
      worktreeId: 'wt-1',
      payload: { state: 'working', toolName: 'Read' },
      agentPresence: { agent: 'claude', process: OWNER_PROCESS }
    })
  })

  it('drops a tool event from another Claude session that inherited the pane env', async () => {
    const server = await startServer()
    await startOwnerTurn(server)

    const response = await postHttpHook(server, { ...readTool, session_id: 'nested-print' })

    expect(response.status).toBe(204)
    expect(ownerRow(server)?.payload.toolName).toBeUndefined()
  })

  it('drops a tool event before any lifecycle event has claimed the pane', async () => {
    const server = await startServer()

    expect((await postHttpHook(server, readTool)).status).toBe(204)
    expect(ownerRow(server)).toBeUndefined()
  })

  it.each([
    ['background job worker', { 'X-Orca-Claude-Job-Dir': '/tmp/job-1' }],
    ['Devin importing Claude hooks', { 'X-Orca-Devin-Project-Dir': '/repo' }],
    ['Grok importing Claude hooks', { 'X-Orca-Grok-Hook-Event': 'pre_tool_use' }],
    [
      'Cursor importing Claude hooks',
      { 'X-Orca-Cursor-Version': '1.0', 'X-Orca-Cursor-Project-Dir': '/repo' }
    ]
  ])('applies the script guard for a %s', async (_host, guard) => {
    const server = await startServer()
    await startOwnerTurn(server)

    expect((await postHttpHook(server, readTool, guard)).status).toBe(204)
    expect(ownerRow(server)?.payload.toolName).toBeUndefined()
  })

  it('answers 204 to a bad token from an http entry but keeps 403 for scripts', async () => {
    const server = await startServer()
    await startOwnerTurn(server)
    const env = server.buildPtyEnv()

    const http = await postHttpHook(server, readTool, { 'X-Orca-Agent-Hook-Token': '' })
    const script = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': 'stale' },
      body: JSON.stringify(buildBody(readTool))
    })

    expect(http.status).toBe(204)
    expect(script.status).toBe(403)
    expect(ownerRow(server)?.payload.toolName).toBeUndefined()
  })

  it('ignores lifecycle events posted with the http marker', async () => {
    const server = await startServer()
    await startOwnerTurn(server)

    await postHttpHook(server, { hook_event_name: 'Stop', session_id: 'session-a' })

    expect(ownerRow(server)?.payload.state).toBe('working')
  })
})

describe.skipIf(process.platform === 'win32')('agent hook endpoint reuse', () => {
  it('keeps the port and token across restarts when asked to', async () => {
    const path = userDataPath()
    const first = await startServer({ userDataPath: path, reuseEndpoint: true })
    const before = first.buildPtyEnv()
    first.stop()

    const second = await startServer({ userDataPath: path, reuseEndpoint: true })
    const after = second.buildPtyEnv()

    expect(after.ORCA_AGENT_HOOK_PORT).toBe(before.ORCA_AGENT_HOOK_PORT)
    expect(after.ORCA_AGENT_HOOK_TOKEN).toBe(before.ORCA_AGENT_HOOK_TOKEN)
  })

  it('keeps the token but takes a new port when the old one is taken', async () => {
    const path = userDataPath()
    const first = await startServer({ userDataPath: path, reuseEndpoint: true })
    const before = first.buildPtyEnv()
    first.stop()
    const squatter: NetServer = createNetServer()
    await new Promise<void>((resolve) =>
      squatter.listen(Number(before.ORCA_AGENT_HOOK_PORT), '127.0.0.1', resolve)
    )
    try {
      const second = await startServer({ userDataPath: path, reuseEndpoint: true })
      const after = second.buildPtyEnv()

      expect(after.ORCA_AGENT_HOOK_PORT).not.toBe(before.ORCA_AGENT_HOOK_PORT)
      expect(Number(after.ORCA_AGENT_HOOK_PORT)).toBeGreaterThan(0)
      expect(after.ORCA_AGENT_HOOK_TOKEN).toBe(before.ORCA_AGENT_HOOK_TOKEN)
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()))
    }
  })

  it('rotates the token on every start by default', async () => {
    const path = userDataPath()
    const first = await startServer({ userDataPath: path })
    const before = first.buildPtyEnv()
    first.stop()

    const second = await startServer({ userDataPath: path })

    expect(second.buildPtyEnv().ORCA_AGENT_HOOK_TOKEN).not.toBe(before.ORCA_AGENT_HOOK_TOKEN)
  })
})
