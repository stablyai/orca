import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import { AgentHookServer } from './server'
import { buildBody, postHookEvent } from './server.test-fixtures'

const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = makePaneKey('tab-1', LEAF)

let dir: string
const servers = new Set<AgentHookServer>()

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-ended-process-'))
})

afterEach(() => {
  for (const server of servers) {
    server.stop()
  }
  servers.clear()
  rmSync(dir, { recursive: true, force: true })
})

async function startServer(): Promise<AgentHookServer> {
  const server = new AgentHookServer()
  servers.add(server)
  await server.start({ env: 'production', userDataPath: dir })
  return server
}

function claudeRow(server: AgentHookServer, state: 'working' | 'waiting' | 'done'): void {
  server.ingestTerminalStatus({
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    connectionId: null,
    payload: { state, prompt: 'review the PR', agentType: 'claude' }
  })
}

function resumableClaudeRow(server: AgentHookServer): void {
  server.ingestRemote(
    {
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      source: 'claude',
      hookEventName: 'UserPromptSubmit',
      launchToken: 'dead-launch-token',
      providerSession: { key: 'session_id', id: 'resume-me' },
      payload: { state: 'working', prompt: 'review the PR', agentType: 'claude' }
    },
    'conn-a'
  )
}

function paneState(server: AgentHookServer): string {
  return server.getStatusSnapshotForPane(PANE)[0]?.state ?? 'missing'
}

// Restored PTYs may lack spawn-time mappings, so ordinary teardown cannot retire their stale rows.
describe('reconcileEndedProcessForPaneKeys', () => {
  it('retires a working row whose process is certifiably dead', async () => {
    const server = await startServer()
    try {
      claudeRow(server, 'working')
      expect(paneState(server)).toBe('working')

      expect(server.reconcileEndedProcessForPaneKeys([PANE])).toBe(1)

      expect(paneState(server)).toBe('missing')
    } finally {
      server.stop()
    }
  })

  it('clears Claude latches even when the stored row already reads done', async () => {
    // Stale latches can re-gate a done row on the next event.
    const server = await startServer()
    try {
      claudeRow(server, 'done')
      server._getStateForTests().claudeRunningNonAgentTaskPaneKeys.add(PANE)
      server._getStateForTests().claudeActiveSessionCronPaneKeys.add(PANE)

      expect(server.reconcileEndedProcessForPaneKeys([PANE])).toBe(1)

      expect(server._getStateForTests().claudeRunningNonAgentTaskPaneKeys.has(PANE)).toBe(false)
      expect(server._getStateForTests().claudeActiveSessionCronPaneKeys.has(PANE)).toBe(false)
      const response = await postHookEvent(server, buildBody({ hook_event_name: 'Stop' }))
      expect(response.status).toBe(204)
      expect(paneState(server)).toBe('done')
    } finally {
      server.stop()
    }
  })

  it('is a no-op for a pane with nothing to retire', async () => {
    const server = await startServer()
    try {
      expect(server.reconcileEndedProcessForPaneKeys([PANE])).toBe(0)
    } finally {
      server.stop()
    }
  })

  it('keeps the resume identity a paired dismissal minted when the shell outlived the agent', async () => {
    // Paired dismissal preserves resume identity; retire live claims without discarding that remnant.
    const server = await startServer()
    try {
      resumableClaudeRow(server)
      server.dropStatusEntry(PANE)
      const afterDrop = server.getStatusSnapshotForPane(PANE)[0]
      expect(afterDrop?.providerSessionOnly).toBe(true)
      expect(afterDrop?.providerSession?.id).toBe('resume-me')

      expect(
        server.reconcileEndedProcessForPaneKeys([PANE], { preserveResumeIdentity: true })
      ).toBe(1)

      const kept = server.getStatusSnapshotForPane(PANE)[0]
      expect(kept?.providerSessionOnly).toBe(true)
      expect(kept?.providerSession?.id).toBe('resume-me')
      expect(kept?.launchToken).toBeUndefined()
      expect(server._getStateForTests().claudeRunningNonAgentTaskPaneKeys.has(PANE)).toBe(false)

      // Resume identity must not restore dead process authority.
      server.flushStatusPersistSync()
      server.stop()
      const restarted = await startServer()
      expect(restarted.getStatusSnapshotForPane(PANE)[0]?.launchToken).toBeUndefined()
      expect(restarted.getHydratedAuthorityCommitments()).toHaveLength(0)
      restarted.stop()
    } finally {
      server.stop()
    }
  })

  it('takes the resume identity too on a certified PTY exit, where no pane is left to resume into', async () => {
    const server = await startServer()
    try {
      resumableClaudeRow(server)
      server.dropStatusEntry(PANE)

      expect(server.reconcileEndedProcessForPaneKeys([PANE])).toBe(1)

      expect(paneState(server)).toBe('missing')
    } finally {
      server.stop()
    }
  })

  it('drops the session owner so a rebound pane is not read as a session replacement', async () => {
    const server = await startServer()
    try {
      claudeRow(server, 'working')
      server._getStateForTests().claudeSessionOwnerByPaneKey.set(PANE, 'session-a')

      server.reconcileEndedProcessForPaneKeys([PANE])

      expect(server._getStateForTests().claudeSessionOwnerByPaneKey.has(PANE)).toBe(false)
      // A fresh unanchored cron must survive the new owner's first lead event.
      for (const payload of [
        { hook_event_name: 'Stop', session_crons: [{ id: 'new-cron' }] },
        { hook_event_name: 'PostToolUse', session_id: 'session-b', tool_name: 'Bash' },
        { hook_event_name: 'Stop', session_id: 'session-b' }
      ]) {
        const response = await postHookEvent(server, buildBody(payload))
        expect(response.status).toBe(204)
      }
      expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
        state: 'working',
        workingMode: 'monitoring',
        mainAgent: { state: 'done' }
      })
    } finally {
      server.stop()
    }
  })
})
