import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentHookServer } from '../../agent-hook-server'
import { claudeSessionWindowTokens } from '../../../../native-chat/claude-session-window-store'

describe('AgentHookServer /statusline/claude', () => {
  let server: AgentHookServer

  beforeEach(async () => {
    server = new AgentHookServer()
    await server.start({ env: 'production' })
  })

  afterEach(() => {
    server.stop()
  })

  function post(body: string): Promise<Response> {
    const env = server.buildPtyEnv()
    return fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/statusline/claude`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
      },
      body
    })
  }

  it('remembers the window size of the reporting session', async () => {
    const payload = JSON.stringify({
      session_id: 'statusline-session',
      context_window: { context_window_size: 1000000 }
    })
    const body = new URLSearchParams({ paneKey: 'pane-1', payload }).toString()

    await expect(post(body)).resolves.toMatchObject({ status: 204 })
    expect(claudeSessionWindowTokens('statusline-session')).toBe(1000000)
  })
})
