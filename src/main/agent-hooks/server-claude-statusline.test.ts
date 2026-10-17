// Why: locks the /statusline/claude loopback contract — form-encoded posts from the
// managed statusline script must reach the listener, and junk must fail open (204).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentHookServer } from './server'
import type { ClaudeStatusLineRateLimits } from '../../shared/claude-statusline-rate-limits'

describe('AgentHookServer /statusline/claude', () => {
  let server: AgentHookServer

  beforeEach(async () => {
    server = new AgentHookServer()
    await server.start({ env: 'production' })
  })

  afterEach(() => {
    server.stop()
  })

  function post(body: string, token?: string): Promise<Response> {
    const env = server.buildPtyEnv()
    return fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/statusline/claude`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Orca-Agent-Hook-Token': token ?? env.ORCA_AGENT_HOOK_TOKEN
      },
      body
    })
  }

  it('forwards parsed rate limits to the statusline listener', async () => {
    const events: ClaudeStatusLineRateLimits[] = []
    server.setClaudeStatusLineListener((event) => {
      events.push(event)
    })

    const payload = JSON.stringify({
      rate_limits: {
        five_hour: { used_percentage: 12.5, resets_at: 1738425600 },
        seven_day: { used_percentage: 40, resets_at: 1712059200 }
      }
    })
    const body = new URLSearchParams({
      paneKey: 'pane-1',
      configDir: '/home/dev/managed',
      payload
    }).toString()

    await expect(post(body)).resolves.toMatchObject({ status: 204 })
    expect(events).toEqual([
      {
        configDir: '/home/dev/managed',
        fiveHour: { used_percentage: 12.5, resets_at: 1738425600 },
        sevenDay: { used_percentage: 40, resets_at: 1712059200 }
      }
    ])
  })

  it('rejects posts with a bad token and ignores payloads without rate limits', async () => {
    const events: ClaudeStatusLineRateLimits[] = []
    server.setClaudeStatusLineListener((event) => {
      events.push(event)
    })

    await expect(post('payload={}', 'wrong-token')).resolves.toMatchObject({ status: 403 })

    const noLimits = new URLSearchParams({
      paneKey: 'pane-1',
      payload: JSON.stringify({ context_window: { used_percentage: 8 } })
    }).toString()
    await expect(post(noLimits)).resolves.toMatchObject({ status: 204 })

    await expect(post('payload=not-json')).resolves.toMatchObject({ status: 204 })

    expect(events).toEqual([])
  })

  it('tells pane listeners which folder a pane reports from, alias-resolved, usage or not', async () => {
    const physical = 'tab-old:11111111-1111-4111-8111-111111111111'
    const stable = 'tab-new:22222222-2222-4222-8222-222222222222'
    server.transferPaneAuthority(physical, stable, 'pty-1')
    const panes: { paneKey: string; configDir: string | null }[] = []
    const usage: ClaudeStatusLineRateLimits[] = []
    server.subscribeClaudeStatusLinePanes((event) => panes.push(event))
    server.setClaudeStatusLineListener((event) => usage.push(event))

    const withUsage = new URLSearchParams({
      paneKey: physical,
      configDir: '/home/dev/managed',
      payload: JSON.stringify({ rate_limits: { five_hour: { used_percentage: 1 } } })
    }).toString()
    const withoutUsage = new URLSearchParams({
      paneKey: stable,
      configDir: '',
      payload: JSON.stringify({ context_window: { used_percentage: 8 } })
    }).toString()
    await expect(post(withUsage)).resolves.toMatchObject({ status: 204 })
    await expect(post(withoutUsage)).resolves.toMatchObject({ status: 204 })
    await expect(post('paneKey=not-a-pane-key&payload={}')).resolves.toMatchObject({ status: 204 })

    expect(panes).toEqual([
      { paneKey: stable, configDir: '/home/dev/managed' },
      { paneKey: stable, configDir: null }
    ])
    expect(usage).toHaveLength(1)
    expect(usage[0]).not.toHaveProperty('paneKey')
  })
})
