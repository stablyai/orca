import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer } from '../../agent-hook-server'
import { buildBody, PANE, postHookEvent } from '../server.test-fixtures'
import type { probeAgentProcessPresence } from '../../../../../shared/agent-status/process/agent-process-presence-probe'
import { CLAUDE_AGENT_VIEW_PATH } from '../../../../../shared/agent-hook-listener/providers/claude/view/claude-agent-view'

vi.mock('../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
const probe = vi.hoisted(() => vi.fn<typeof probeAgentProcessPresence>(async () => 'live'))
vi.mock('../../../../../shared/agent-status/process/agent-process-presence-probe', () => ({
  probeAgentProcessPresence: probe
}))

const dirs: string[] = []
const servers: AgentHookServer[] = []

afterEach(() => {
  probe.mockReset().mockResolvedValue('live')
  for (const server of servers.splice(0)) {
    server.stop()
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const PROCESS = JSON.stringify({ pid: 4001, platform: 'linux', startTime: 'birth-4001' })

async function claudeAfterTurn(agentProcess?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-view-quiet-'))
  dirs.push(dir)
  const server = new AgentHookServer()
  servers.push(server)
  await server.start({ env: 'production', userDataPath: join(dir, 'user-data') })
  for (const hook_event_name of ['UserPromptSubmit', 'Stop']) {
    await postHookEvent(
      server,
      buildBody(
        { hook_event_name, session_id: 'claude-parent', prompt: 'Task' },
        agentProcess ? { agentProcess } : {}
      )
    )
  }
  const env = server.buildPtyEnv()
  const post = async (action: string, extra: Record<string, unknown> = {}) => {
    const response = await fetch(
      `http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}${CLAUDE_AGENT_VIEW_PATH}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-orca-agent-hook-token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify({
          paneKey: PANE,
          sessionId: 'claude-parent',
          instanceId: 'mod-1',
          action,
          ...extra
        })
      }
    )
    return response.json()
  }
  const register = () =>
    post('register', {
      keybindings: JSON.stringify({
        bindings: [{ context: 'Chat', bindings: { 'ctrl+alt+g': 'command:orca-agent-view' } }]
      }),
      configDir: join(dir, 'claude')
    })
  return { server, post, register }
}

describe('Claude agent view check-in', () => {
  it('lets a mod go quiet only when a click can probe its Claude process', async () => {
    // Native Windows hooks record no process: a click could not tell Claude from its successor.
    expect(await (await claudeAfterTurn()).register()).toEqual({ registered: true })
    expect(await (await claudeAfterTurn(PROCESS)).register()).toEqual({
      registered: true,
      durable: true
    })
  })

  it('drops a quiet pane once another agent replaces its Claude without a recorded exit', async () => {
    const { server, post, register } = await claudeAfterTurn(PROCESS)
    await register()
    expect(await post('take')).toEqual({})
    // Claude stopped by job control: Codex takes the pane while no exit is recorded.
    probe.mockImplementation(async (_identity, _read, _platform, observe) => {
      observe?.(true)
      return 'unverifiable'
    })
    await postHookEvent(
      server,
      buildBody({ hook_event_name: 'UserPromptSubmit', session_id: 'codex-1', prompt: 'Next' }),
      '/hook/codex'
    )
    expect(await post('take')).toEqual({ unknown: true })
  })
})
