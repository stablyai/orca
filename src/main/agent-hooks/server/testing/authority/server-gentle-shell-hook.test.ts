import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentHookServer, _internals } from '../../agent-hook-server'
import { buildBody, PANE, postHookEvent } from '../server.test-fixtures'

describe('gentle-shell hook route', () => {
  let userDataPath: string

  beforeEach(() => {
    _internals.resetCachesForTests()
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-gentle-shell-hook-'))
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('reports a /hook/gentle-shell turn as the gentle-shell agent', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      const start = await postHookEvent(
        server,
        buildBody({ hook_event_name: 'before_agent_start', prompt: 'ship the change' }),
        '/hook/gentle-shell'
      )
      const end = await postHookEvent(
        server,
        buildBody({ hook_event_name: 'agent_end' }),
        '/hook/gentle-shell'
      )

      expect(start.status).toBe(204)
      expect(end.status).toBe(204)
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          paneKey: PANE,
          state: 'done',
          prompt: 'ship the change',
          agentType: 'gentle-shell'
        })
      ])
    } finally {
      server.stop()
    }
  })
})
