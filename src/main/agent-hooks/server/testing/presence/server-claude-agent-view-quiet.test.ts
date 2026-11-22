import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer } from '../../agent-hook-server'
import { buildBody, PANE, postHookEvent } from '../server.test-fixtures'
import { CLAUDE_AGENT_VIEW_PATH } from '../../../../../shared/agent-hook-listener/providers/claude/view/claude-agent-view'

vi.mock('../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

const dirs: string[] = []
const servers: AgentHookServer[] = []

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

async function registerAfterTurn(agentProcess?: string): Promise<unknown> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-view-quiet-'))
  dirs.push(dir)
  const server = new AgentHookServer()
  servers.push(server)
  await server.start({ env: 'production', userDataPath: join(dir, 'user-data') })
  await postHookEvent(
    server,
    buildBody(
      { hook_event_name: 'UserPromptSubmit', session_id: 'claude-parent', prompt: 'Task' },
      agentProcess ? { agentProcess } : {}
    )
  )
  const env = server.buildPtyEnv()
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
        action: 'register',
        keybindings: JSON.stringify({
          bindings: [{ context: 'Chat', bindings: { 'ctrl+alt+g': 'command:orca-agent-view' } }]
        }),
        configDir: join(dir, 'claude')
      })
    }
  )
  return response.json()
}

describe('Claude agent view check-in', () => {
  it('lets a mod go quiet only when a click can probe its Claude process', async () => {
    // Native Windows hooks record no process: a click could not tell Claude from its successor.
    expect(await registerAfterTurn()).toEqual({ registered: true })
    expect(
      await registerAfterTurn(
        JSON.stringify({ pid: 4001, platform: 'linux', startTime: 'birth-4001' })
      )
    ).toEqual({ registered: true, durable: true })
  })
})
