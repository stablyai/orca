import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer } from './server'
import { lookupOpenCodeSessionPane } from '../../shared/agent-hook-listener/opencode-session-registry'
import { makePaneKey } from '../../shared/workspace-layout/stable-pane-id'

const PANE_A = makePaneKey('tab-a', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')

class IsolatedHookServer extends AgentHookServer {
  isolateBinder(dbPath: string) {
    this._setOpenCodeBinderDepsForTests({
      dbPath: () => dbPath,
      listPanes: () => [],
      sweep: async () => []
    })
  }
}

describe('legacy TUI identity admitted by the canonical hook server', () => {
  let dir: string
  let server: IsolatedHookServer

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-opencode-tui-host-'))
    server = new IsolatedHookServer()
    server.isolateBinder(join(dir, 'no-user-database'))
    await server.start({ env: 'test', userDataPath: dir })
  })
  afterEach(() => {
    server.stop()
    rmSync(dir, { recursive: true, force: true })
  })
  const binding = (id: string) => lookupOpenCodeSessionPane(server._getStateForTests(), id)

  it('rejects another execution host token before learning its identity', async () => {
    const other = new IsolatedHookServer()
    other.isolateBinder(join(dir, 'other-no-user-database'))
    await other.start({ env: 'other-host', userDataPath: join(dir, 'other-host') })
    try {
      const { ORCA_AGENT_HOOK_PORT } = server.buildPtyEnv()
      const { ORCA_AGENT_HOOK_TOKEN } = other.buildPtyEnv()
      const response = await fetch(`http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/opencode`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify({
          paneKey: PANE_A,
          env: 'other-host',
          opencodeTui: 1,
          payload: { hook_event_name: 'SessionBusy', sessionID: 'ses_other_host' }
        })
      })
      expect(response.status).toBe(403)
      expect(binding('ses_other_host')).toBeUndefined()
      expect(server.getStatusSnapshot()).toEqual([])
    } finally {
      other.stop()
    }
  })
})
