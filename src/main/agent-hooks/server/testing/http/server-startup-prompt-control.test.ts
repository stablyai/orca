import { readSavedStatus, hasSavedStatus } from '../persistence/last-status.test-fixtures'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../agent-hook-server'
import { parseAgentHookEndpointFile } from '../../../../../shared/agent-hook-listener/transport/agent-hook-endpoint-file'
import { OPENCODE_STARTUP_PROMPT_CLAIM_PATH } from '../../../../../shared/agent-launch/startup/opencode-startup-prompt'
import { PANE } from '../server.test-fixtures'

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
        expect(hasSavedStatus(statusPath)).toBe(true)
        expect(JSON.parse(readSavedStatus(statusPath)).entries[PANE]).toMatchObject({
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
