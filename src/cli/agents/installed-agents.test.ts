import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeClient } from '../runtime/client'
import { RuntimeClientError } from '../runtime/connection/types'
import { INSTALLED_AGENT_HANDLERS } from './installed-agents'

describe('agent installed CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps the host-default list available on older runtimes', async () => {
    const client = new RuntimeClient('/tmp/orca-installed-test', 60_000, null, null)
    vi.spyOn(client, 'call').mockImplementation(async (method: string) => {
      if (method === 'preflight.installedAgents') {
        throw new RuntimeClientError('method_not_found', 'Unknown method')
      }
      return {
        id: 'req-1',
        ok: true as const,
        result: method === 'preflight.detectAgents' ? ['codex'] : { settings: null },
        _meta: { runtimeId: 'runtime-1' }
      }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await INSTALLED_AGENT_HANDLERS['agent installed']({
      flags: new Map(),
      client,
      cwd: '/tmp/worktree',
      json: true
    })

    expect(JSON.parse(log.mock.calls[0][0]).result.agents).toEqual([
      { id: 'codex', name: 'Codex', default: false }
    ])
  })
})
