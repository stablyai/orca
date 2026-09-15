import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { normalizeHookPayload } from '../../shared/agent-hook-listener'
import { createHookListenerState } from '../../shared/agent-hook-listener/listener-state'
import { PANE_KEY } from '../../shared/agent-hook-listener-test-harness'
import { buildRelayHookEnvelope } from '../../relay/agent-hook-envelope-build'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))

const servers: AgentHookServer[] = []
afterEach(() => {
  for (const server of servers) {
    server.stop()
  }
  servers.length = 0
})

function setup() {
  const server = new AgentHookServer()
  servers.push(server)
  const relayState = createHookListenerState()
  function envelope(payload: Record<string, unknown>) {
    const event = normalizeHookPayload(
      relayState,
      'codex',
      {
        paneKey: PANE_KEY,
        tabId: 'tab-1',
        worktreeId: 'folder-workspace',
        payload
      },
      'production'
    )
    if (!event) {
      throw new Error('Expected a Codex hook')
    }
    return buildRelayHookEnvelope(event, 'codex')
  }
  function ingest(payload: Record<string, unknown>) {
    server.ingestRemote(envelope(payload), 'synthetic-connection')
    return server.getStatusSnapshot()[0]
  }
  return { server, envelope, ingest }
}

const automaticPermission = {
  hook_event_name: 'PermissionRequest',
  permission_mode: 'bypassPermissions',
  tool_name: 'Bash',
  tool_input: { command: 'sleep 10' }
}

describe('Codex noninteractive permissions across SSH normalization', () => {
  it('stores the noninteractive status from an authenticated local hook POST', async () => {
    const { server } = setup()
    await server.start({ env: 'production' })
    const env = server.buildPtyEnv()
    const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/codex`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
      },
      body: JSON.stringify({ paneKey: PANE_KEY, payload: automaticPermission })
    })
    expect(response.status).toBe(204)
    expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'working', toolName: 'Bash' })
    expect(server.getStatusSnapshot()[0]?.interactivePrompt).toBeUndefined()
  })

  it('preserves host normalization in the authoritative store for a folder workspace', () => {
    const { ingest } = setup()
    expect(ingest(automaticPermission)).toMatchObject({
      state: 'working',
      worktreeId: 'folder-workspace',
      toolName: 'Bash'
    })
  })

  it('keeps a child human wait visible without stranding the noninteractive parent', () => {
    const { ingest } = setup()
    ingest({ hook_event_name: 'SessionStart' })
    ingest({ hook_event_name: 'SubagentStart', agent_id: 'synthetic-child' })
    expect(
      ingest({
        ...automaticPermission,
        agent_id: 'synthetic-child',
        permission_mode: 'default'
      })?.state
    ).toBe('waiting')
    expect(ingest(automaticPermission)?.state).toBe('waiting')
    expect(
      ingest({
        hook_event_name: 'SubagentStop',
        agent_id: 'synthetic-child'
      })?.state
    ).toBe('working')
  })

  it('does not make a child noninteractive permission hook hide the parent human approval', () => {
    const { ingest } = setup()
    ingest({ hook_event_name: 'SessionStart' })
    ingest({ ...automaticPermission, permission_mode: 'default' })
    expect(ingest({ ...automaticPermission, agent_id: 'synthetic-child' })?.state).toBe('waiting')
  })

  it('retains attention with an old relay that has no noninteractive proof', () => {
    const { server, envelope } = setup()
    const legacy = envelope({ ...automaticPermission, permission_mode: undefined })
    expect(legacy.codexNonInteractivePermission).toBeUndefined()
    server.ingestRemote(JSON.parse(JSON.stringify(legacy)), 'synthetic-connection')
    expect(server.getStatusSnapshot()[0]?.state).toBe('waiting')
  })

  it('fails open if an older transport strips the optional proof', () => {
    const { server, envelope } = setup()
    const current = envelope(automaticPermission)
    const { codexNonInteractivePermission: _proof, ...legacy } = current
    server.ingestRemote(legacy, 'synthetic-connection')
    expect(server.getStatusSnapshot()[0]?.state).toBe('waiting')
  })

  it.each([false, 'true', 1])('rejects malformed remote proof (%s)', (proof) => {
    const { server, envelope } = setup()
    server.ingestRemote(
      {
        ...envelope({ ...automaticPermission, permission_mode: 'default' }),
        codexNonInteractivePermission: proof
      },
      'synthetic-connection'
    )
    expect(server.getStatusSnapshot()[0]?.state).toBe('waiting')
  })

  it('preserves the normal question PreToolUse across the relay', () => {
    const { ingest } = setup()
    expect(
      ingest({
        ...automaticPermission,
        hook_event_name: 'PreToolUse',
        tool_name: 'request_user_input'
      })?.state
    ).toBe('waiting')
  })

  it('never applies remote permission proof to a human question', () => {
    const { server, envelope } = setup()
    server.ingestRemote(
      {
        ...envelope({ ...automaticPermission, tool_name: 'request_user_input' }),
        codexNonInteractivePermission: true
      },
      'synthetic-connection'
    )
    expect(server.getStatusSnapshot()[0]?.state).toBe('waiting')
  })
})
