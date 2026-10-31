import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer, _internals } from './server'
import { GOOD_PANE as REMOTE_PANE, PANE } from './server.test-fixtures'

describe('restored agent status', () => {
  let userDataPath: string

  beforeEach(() => {
    _internals.resetCachesForTests()
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-restored-status-'))
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it("returns the last report a pane's agent sent before the app restarted", async () => {
    const before = new AgentHookServer()
    await before.start({ env: 'production', userDataPath })
    before.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      connectionId: null,
      payload: { state: 'done', prompt: 'review', agentType: 'codex' }
    })
    // A remote host's row cannot be checked against a local process.
    before.ingestTerminalStatus({
      paneKey: REMOTE_PANE,
      tabId: 'tab-good',
      worktreeId: 'wt-1',
      connectionId: 'ssh-1',
      payload: { state: 'done', prompt: 'review', agentType: 'codex' }
    })
    before.flushStatusPersistSync()
    before.stop()

    const after = new AgentHookServer()
    await after.start({ env: 'production', userDataPath })
    try {
      expect(await after.readRestoredAgentStatus(PANE)).toMatchObject({ state: 'done' })
      expect(after.getStatusSnapshot().map((row) => row.paneKey)).toContain(REMOTE_PANE)
      expect(await after.readRestoredAgentStatus(REMOTE_PANE)).toBeNull()
      after.setStatusHooksEnabled(false)
      expect(await after.readRestoredAgentStatus(PANE)).toBeNull()
    } finally {
      after.stop()
    }
  })
})
