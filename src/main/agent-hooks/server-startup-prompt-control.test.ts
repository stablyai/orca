import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { parseAgentHookEndpointFile } from '../../shared/agent-hook-endpoint-file'
import { OPENCODE_STARTUP_PROMPT_CLAIM_PATH } from '../../shared/opencode-startup-prompt'
import { PANE } from './server.test-fixtures'

describe('startup prompt control with status hooks disabled', () => {
  it.each([false, true])(
    'persists a pending terminal status at shutdown after starting with hooks %s',
    async (statusHooksEnabled) => {
      const dir = mkdtempSync(join(tmpdir(), 'orca-prompt-terminal-persist-'))
      const server = new AgentHookServer()
      try {
        await server.start({ userDataPath: dir, statusHooksEnabled })
        server.setStatusHooksEnabled(false)
        server.ingestTerminalStatus({
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'folder-1',
          payload: { state: 'done', prompt: 'terminal status survives quit', agentType: 'opencode' }
        })
        expect(server.getStatusSnapshotForPane(PANE)[0]?.state).toBe('done')
        const statusPath = server.lastStatusPath
        if (!statusPath) {
          throw new Error('missing status persistence path')
        }
        server.stop()
        expect(existsSync(statusPath)).toBe(true)
        expect(JSON.parse(readFileSync(statusPath, 'utf8')).entries[PANE]).toMatchObject({
          paneKey: PANE,
          worktreeId: 'folder-1',
          payload: { state: 'done', prompt: 'terminal status survives quit', agentType: 'opencode' }
        })
      } finally {
        server.stop()
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )

  it('enables and disables status without restarting the control listener', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-prompt-toggle-'))
    class IsolatedHookServer extends AgentHookServer {
      constructor() {
        super()
        this._setOpenCodeBinderDepsForTests({
          dbPath: () => join(dir, 'no-user-db'),
          listSessions: async () => [],
          listPanes: () => [],
          sweep: async () => []
        })
      }
    }
    const server = new IsolatedHookServer()
    try {
      await server.start({ userDataPath: dir, statusHooksEnabled: false })
      const endpoint = server.endpointFilePath
      if (!endpoint) {
        throw new Error('missing control endpoint')
      }
      const coords = parseAgentHookEndpointFile(readFileSync(endpoint, 'utf8'))
      const post = (path: string) =>
        fetch(`http://127.0.0.1:${coords.port}${path}`, {
          method: 'POST',
          headers: { 'x-orca-agent-hook-token': coords.token },
          body: '{}'
        })
      expect((await post('/hook/opencode')).status).toBe(404)
      await server.start({ statusHooksEnabled: true })
      expect(server.buildPtyEnv()).toHaveProperty('ORCA_AGENT_HOOK_PORT', coords.port)
      expect((await post('/hook/opencode')).status).toBe(204)
      server.setStatusHooksEnabled(false)
      expect(server.buildPtyEnv()).toEqual({})
      expect((await post('/hook/opencode')).status).toBe(404)
      await server.start()
      expect((await post('/hook/opencode')).status).toBe(404)
      server.setStartupPromptClaimListener(
        () => 'pending',
        () => {}
      )
      expect(await (await post(OPENCODE_STARTUP_PROMPT_CLAIM_PATH)).json()).toEqual({
        allowed: false,
        pending: true
      })
      server.setStatusHooksEnabled(true)
      expect((await post('/hook/opencode')).status).toBe(204)
      expect(server.endpointFilePath).toBe(endpoint)
      expect(parseAgentHookEndpointFile(readFileSync(endpoint, 'utf8'))).toEqual(coords)
    } finally {
      server.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('authenticates claims, denies malformed or missing handlers, and refuses status posts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-prompt-control-'))
    const server = new AgentHookServer()
    try {
      await server.start({ userDataPath: dir, statusHooksEnabled: false })
      expect(server.buildPtyEnv()).toEqual({})
      const statusPath = server.lastStatusPath
      if (!statusPath) {
        throw new Error('missing status persistence path')
      }
      writeFileSync(statusPath, 'existing status must survive control-only shutdown')
      const endpoint = server.endpointFilePath
      if (!endpoint) {
        throw new Error('missing control endpoint')
      }
      const coords = parseAgentHookEndpointFile(readFileSync(endpoint, 'utf8'))
      const post = (path: string, body: string, token = coords.token) =>
        fetch(`http://127.0.0.1:${coords.port}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-orca-agent-hook-token': token },
          body
        })
      expect((await post(OPENCODE_STARTUP_PROMPT_CLAIM_PATH, '{}', 'wrong')).status).toBe(403)
      expect(await (await post(OPENCODE_STARTUP_PROMPT_CLAIM_PATH, '{}')).json()).toEqual({
        allowed: false
      })
      const clear = vi.fn()
      const claim = vi.fn(() => true)
      server.setStartupPromptClaimListener(claim, clear)
      expect(await (await post(OPENCODE_STARTUP_PROMPT_CLAIM_PATH, '{}')).json()).toEqual({
        allowed: true
      })
      expect(await (await post(OPENCODE_STARTUP_PROMPT_CLAIM_PATH, '{')).json()).toEqual({
        allowed: false
      })
      expect(claim).toHaveBeenCalledTimes(1)
      expect((await post('/hook/opencode', '{}')).status).toBe(404)
      expect((await post('/statusline/claude', '{}')).status).toBe(404)
      server.stop()
      expect(clear).toHaveBeenCalledTimes(1)
      expect(readFileSync(statusPath, 'utf8')).toBe(
        'existing status must survive control-only shutdown'
      )
    } finally {
      server.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
