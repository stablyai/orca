import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeClient } from '../runtime/client'
import { INSTALLED_AGENT_HANDLERS } from './installed-agents'

describe('agent installed CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('omits agents turned off in Settings, since launch refuses them', async () => {
    const client = new RuntimeClient('/tmp/orca-installed-test', 60_000, null, null)
    vi.spyOn(client, 'call').mockImplementation(async (method: string) => ({
      id: 'req-1',
      ok: true as const,
      result:
        method === 'preflight.detectAgents'
          ? ['claude', 'codex', 'gemini']
          : { settings: { disabledTuiAgents: ['codex'], defaultTuiAgent: 'gemini' } },
      _meta: { runtimeId: 'runtime-1' }
    }))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await INSTALLED_AGENT_HANDLERS['agent installed']({
      flags: new Map(),
      client,
      cwd: '/tmp/worktree',
      json: true
    })

    expect(JSON.parse(log.mock.calls[0][0]).result.agents).toEqual([
      { id: 'claude', name: 'Claude', default: false },
      { id: 'gemini', name: 'Gemini', default: true }
    ])
  })
})
