import { readSavedStatus, hasSavedStatus } from '../persistence/last-status.test-fixtures'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentHookServer } from '../../agent-hook-server'
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
})
