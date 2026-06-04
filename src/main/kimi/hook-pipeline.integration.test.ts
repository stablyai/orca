import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AgentHookServer } from '../agent-hooks/server'
import { makePaneKey } from '../../shared/stable-pane-id'

// Why: end-to-end proof of the Kimi live-status pipeline over the real loopback
// HTTP socket — the exact path a managed kimi-hook.sh POST takes:
// HTTP POST /hook/kimi → readRequestBody → resolveHookSource → normalizeKimiEvent
// → applyNormalizedStatus → listener. Binds an ephemeral port (listen(0)) so it
// never collides with a running Orca dev instance.
const PANE = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')

type Captured = {
  payload: {
    state: string
    prompt: string
    agentType?: string
    toolName?: string
    toolInput?: string
  }
}

async function postKimiHook(
  port: string,
  token: string,
  payload: Record<string, unknown>
): Promise<number> {
  const body = new URLSearchParams({
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: '/tmp/wt',
    env: 'production',
    version: '1',
    payload: JSON.stringify(payload)
  }).toString()
  const res = await fetch(`http://127.0.0.1:${port}/hook/kimi`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Orca-Agent-Hook-Token': token
    },
    body
  })
  return res.status
}

describe('Kimi hook pipeline (real HTTP round-trip)', () => {
  let server: AgentHookServer | null = null
  let dir: string | null = null

  afterEach(() => {
    server?.stop()
    server = null
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
      dir = null
    }
  })

  it('routes a real /hook/kimi POST through to live working/tool/done statuses', async () => {
    server = new AgentHookServer()
    const events: Captured[] = []
    server.setListener((e) => events.push(e as unknown as Captured))
    dir = mkdtempSync(join(tmpdir(), 'kimi-hooksrv-'))
    await server.start({ env: 'production', userDataPath: dir })

    const env = server.buildPtyEnv()
    const port = env.ORCA_AGENT_HOOK_PORT
    const token = env.ORCA_AGENT_HOOK_TOKEN
    expect(port).toBeTruthy()
    expect(token).toBeTruthy()

    // Why: Kimi posts snake_case keys (engine.ts toHookInputData → camelToSnake).
    // 0) SessionStart is observation-only → 204 but must NOT emit a status row.
    expect(
      await postKimiHook(port, token, {
        hook_event_name: 'SessionStart',
        session_id: 's1',
        cwd: '/tmp',
        source: 'startup'
      })
    ).toBe(204)
    expect(events).toHaveLength(0)

    // 1) UserPromptSubmit → working, prompt captured (ContentPart[] flattened),
    //    agentType kimi
    expect(
      await postKimiHook(port, token, {
        hook_event_name: 'UserPromptSubmit',
        session_id: 's1',
        cwd: '/tmp',
        prompt: [{ type: 'text', text: 'ship the feature' }]
      })
    ).toBe(204)

    // 2) PreToolUse Shell → still working, tool name + command preview
    expect(
      await postKimiHook(port, token, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Shell',
        tool_input: { command: 'pnpm test', description: 'run tests' },
        tool_call_id: 'call_1'
      })
    ).toBe(204)

    // 3) PermissionRequest → waiting (red dot)
    expect(
      await postKimiHook(port, token, {
        hook_event_name: 'PermissionRequest',
        tool_name: 'Shell',
        tool_input: { command: 'pnpm test' }
      })
    ).toBe(204)

    // 4) Stop → done
    expect(
      await postKimiHook(port, token, {
        hook_event_name: 'Stop',
        session_id: 's1',
        cwd: '/tmp',
        stop_hook_active: false
      })
    ).toBe(204)

    const states = events.map((e) => e.payload.state)
    expect(states).toContain('working')
    expect(states).toContain('waiting')
    expect(states.at(-1)).toBe('done')

    const working = events.find((e) => e.payload.toolName === 'Shell')
    expect(working?.payload.agentType).toBe('kimi')
    expect(working?.payload.toolInput).toBe('pnpm test')

    const first = events.find((e) => e.payload.prompt === 'ship the feature')
    expect(first?.payload.agentType).toBe('kimi')
    expect(first?.payload.state).toBe('working')
  })
})
