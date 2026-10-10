import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../shared/agent-status-types'
import { PANE, buildBody } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

class IsolatedHookServer extends AgentHookServer {
  isolateBinder(dbPath: string) {
    this._setOpenCodeBinderDepsForTests({
      dbPath: () => dbPath,
      listPanes: () => [],
      sweep: async () => []
    })
  }
}

describe('inherited hooks cannot replace an active pane owner metadata', () => {
  let server: IsolatedHookServer
  let dir: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-inherited-hook-'))
    server = new IsolatedHookServer()
    server.isolateBinder(join(dir, 'no-database'))
    await server.start({ env: 'production', userDataPath: dir })
  })

  afterEach(() => {
    server.stop()
    vi.useRealTimers()
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  async function post(source: 'opencode' | 'claude', payload: Record<string, unknown>) {
    const env = server.buildPtyEnv()
    const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/${source}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
      },
      body: JSON.stringify(buildBody(payload, { launchToken: 'same-inherited-launch' }))
    })
    expect(response.status).toBe(204)
  }

  async function startOpenCode() {
    await post('opencode', {
      hook_event_name: 'MessagePart',
      role: 'user',
      text: 'OpenCode parent prompt',
      sessionID: 'ses_opencode_parent'
    })
  }

  it.each(['PreToolUse', 'PermissionRequest', 'UserPromptSubmit', 'Stop'])(
    'keeps the complete parent row after an inherited Claude %s',
    async (hookEventName) => {
      await startOpenCode()
      const previous = server.getStatusSnapshotForPane(PANE)[0]
      const listener = vi.fn()
      server.setListener(listener)
      listener.mockClear()

      await post('claude', {
        hook_event_name: hookEventName,
        session_id: '725ba8fe-c702-44f3-9da4-eded1e8c214f',
        prompt: 'foreign prompt',
        tool_name: 'Bash',
        tool_input: { command: 'printf inherited-compatible-hook13385' },
        model: 'foreign-model'
      })

      expect(server.getStatusSnapshotForPane(PANE)).toEqual([previous])
      expect(listener).not.toHaveBeenCalled()
      expect(server._getStateForTests().claudeSessionOwnerByPaneKey.has(PANE)).toBe(false)
    }
  )

  it('does not leak rejected Claude tool or prompt caches into the next OpenCode event', async () => {
    await startOpenCode()
    await post('claude', {
      hook_event_name: 'PreToolUse',
      session_id: 'foreign-session',
      prompt: 'foreign prompt',
      tool_name: 'Bash',
      tool_input: { command: 'foreign command' },
      background_tasks: [{ id: 'foreign-shell', type: 'shell', status: 'running' }]
    })
    await post('opencode', { hook_event_name: 'SessionBusy', sessionID: 'ses_opencode_parent' })

    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      agentType: 'opencode',
      state: 'working',
      prompt: 'OpenCode parent prompt',
      providerSession: { key: 'session_id', id: 'ses_opencode_parent' }
    })
    expect(server.getStatusSnapshotForPane(PANE)[0]?.toolName).toBeUndefined()
    expect(server.getStatusSnapshotForPane(PANE)[0]?.toolInput).toBeUndefined()
    expect(server._getStateForTests().claudeRunningNonAgentTaskPaneKeys.has(PANE)).toBe(false)
  })

  it('continues accepting the owning OpenCode tool and completion', async () => {
    await startOpenCode()
    await post('opencode', {
      hook_event_name: 'PermissionRequest',
      sessionID: 'ses_opencode_parent',
      permission: 'shell',
      metadata: { command: 'owned command' }
    })
    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      state: 'waiting',
      toolName: 'shell',
      toolInput: 'owned command',
      providerSession: { key: 'session_id', id: 'ses_opencode_parent' }
    })
    await post('opencode', { hook_event_name: 'SessionIdle', sessionID: 'ses_opencode_parent' })
    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      agentType: 'opencode',
      state: 'done',
      providerSession: { key: 'session_id', id: 'ses_opencode_parent' }
    })
  })

  it('allows a new provider to take over after the previous turn completes', async () => {
    await startOpenCode()
    await post('opencode', { hook_event_name: 'SessionIdle', sessionID: 'ses_opencode_parent' })
    await post('claude', {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'new-session',
      prompt: 'new Claude turn'
    })
    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      agentType: 'claude',
      prompt: 'new Claude turn',
      providerSession: { key: 'session_id', id: 'new-session' }
    })
  })

  it('allows a local hook to take over after the previous owner becomes stale', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    await startOpenCode()
    now.mockReturnValue(1_001 + AGENT_STATUS_STALE_AFTER_MS)
    await post('claude', {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'new-session',
      prompt: 'new Claude turn'
    })
    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      agentType: 'claude',
      prompt: 'new Claude turn',
      providerSession: { key: 'session_id', id: 'new-session' }
    })
  })

  it.each([true, false])('preserves remote metadata with source present=%s', (hasSource) => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const parent = {
      paneKey: PANE,
      source: 'opencode' as const,
      providerSession: { key: 'session_id' as const, id: 'ses_remote_parent' },
      payload: { state: 'working' as const, prompt: 'parent', agentType: 'opencode' as const }
    }
    server.ingestRemote(parent, 'ssh-owned')
    const previous = server.getStatusSnapshotForPane(PANE)[0]
    vi.setSystemTime(1_100)
    server.ingestRemote(
      {
        paneKey: PANE,
        ...(hasSource ? { source: 'claude' as const } : {}),
        providerSession: { key: 'session_id', id: 'foreign-session' },
        hookEventName: 'PreToolUse',
        payload: { state: 'working', prompt: 'foreign', agentType: 'claude', toolName: 'Bash' }
      },
      'ssh-owned'
    )
    expect(server.getStatusSnapshotForPane(PANE)).toEqual([previous])
  })

  it('retains stale-owner takeover behavior for remote hooks', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    server.ingestRemote(
      { paneKey: PANE, payload: { state: 'working', prompt: 'old', agentType: 'opencode' } },
      'ssh-owned'
    )
    vi.setSystemTime(1_001 + AGENT_STATUS_STALE_AFTER_MS)
    server.ingestRemote(
      { paneKey: PANE, payload: { state: 'working', prompt: 'new', agentType: 'claude' } },
      'ssh-owned'
    )
    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      agentType: 'claude',
      prompt: 'new'
    })
  })
})
