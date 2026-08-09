import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { makePaneKey } from '../../shared/stable-pane-id'

const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const servers: AgentHookServer[] = []

function createServer(): AgentHookServer {
  const server = new AgentHookServer()
  servers.push(server)
  return server
}

async function postClaudeHook(
  server: AgentHookServer,
  payload: Record<string, unknown>
): Promise<Response> {
  const env = server.buildPtyEnv()
  return fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
    },
    body: JSON.stringify({
      paneKey: PANE_KEY,
      tabId: 'tab-1',
      worktreeId: 'worktree-1',
      launchToken: 'opencode-launch-token',
      env: 'production',
      payload
    })
  })
}

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
})

describe('AgentHookServer inherited OpenCode hook identity', () => {
  it('persists the corroborated OpenCode identity without Claude session metadata', async () => {
    const server = createServer()
    const resolver = vi.fn(async () => 'opencode' as const)
    server.setLocalStatusIdentityResolver(resolver)
    await server.start({ env: 'production' })

    await expect(
      postClaudeHook(server, {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Continue weighted SLO scheduling work',
        session_id: 'inherited-claude-session',
        model: 'claude-sonnet'
      })
    ).resolves.toMatchObject({ status: 204 })
    await expect(
      postClaudeHook(server, {
        hook_event_name: 'Stop',
        session_id: 'inherited-claude-session',
        model: 'claude-sonnet'
      })
    ).resolves.toMatchObject({ status: 204 })

    expect(resolver).toHaveBeenCalledOnce()
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        paneKey: PANE_KEY,
        state: 'working',
        prompt: 'Continue weighted SLO scheduling work',
        agentType: 'opencode'
      })
    ])
    expect(server.getStatusSnapshot()[0]).not.toHaveProperty('model')
    expect(server.getStatusSnapshot()[0]).not.toHaveProperty('providerSession')
  })

  it('suppresses a first inherited Claude completion while OpenCode is foreground', async () => {
    const server = createServer()
    server.setLocalStatusIdentityResolver(async () => 'opencode')
    await server.start({ env: 'production' })

    await expect(
      postClaudeHook(server, {
        hook_event_name: 'Stop',
        session_id: 'inherited-claude-session',
        model: 'claude-sonnet'
      })
    ).resolves.toMatchObject({ status: 204 })

    expect(server.getStatusSnapshot()).toEqual([])
  })

  it('does not consult local foreground identity for remote hook ingestion', () => {
    const server = createServer()
    const resolver = vi.fn(async () => 'opencode' as const)
    server.setLocalStatusIdentityResolver(resolver)

    server.ingestRemote(
      {
        paneKey: PANE_KEY,
        tabId: 'tab-1',
        worktreeId: 'worktree-1',
        payload: {
          state: 'working',
          prompt: 'remote work',
          agentType: 'claude',
          model: 'claude-sonnet'
        }
      },
      'ssh-connection-1'
    )

    expect(resolver).not.toHaveBeenCalled()
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      connectionId: 'ssh-connection-1',
      agentType: 'claude',
      model: 'claude-sonnet'
    })
  })
})
