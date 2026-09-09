import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import { AgentHookServer } from './server'

const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = makePaneKey('tab-1', LEAF)

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-ended-process-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function startServer(): Promise<AgentHookServer> {
  const server = new AgentHookServer()
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

/** A row carrying a resumable provider session — the only shape `dropStatusEntry` retains. */
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

// The teardown that normally clears a dead pane depends on the spawn-time ptyPaneKey mapping, which
// a restored PTY may never rebuild — leaving the row and its latches with nothing left to retire
// them. See PLAN-STA-4612 §4.2.
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

  it('retires a waiting row — a wait whose owner is dead is not a wait', async () => {
    const server = await startServer()
    try {
      claudeRow(server, 'waiting')

      expect(server.reconcileEndedProcessForPaneKeys([PANE])).toBe(1)

      expect(paneState(server)).toBe('missing')
    } finally {
      server.stop()
    }
  })

  it('clears Claude latches even when the stored row already reads done', async () => {
    // An interrupted lead suppresses the gate while leaving the latch set, so a row can read `done`
    // with a latch that would re-gate `working` on the pane's very next event.
    const server = await startServer()
    try {
      claudeRow(server, 'done')
      server._getStateForTests().claudeRunningNonAgentTaskPaneKeys.add(PANE)
      server._getStateForTests().claudeActiveSessionCronPaneKeys.add(PANE)

      expect(server.reconcileEndedProcessForPaneKeys([PANE])).toBe(1)

      expect(server._getStateForTests().claudeRunningNonAgentTaskPaneKeys.has(PANE)).toBe(false)
      expect(server._getStateForTests().claudeActiveSessionCronPaneKeys.has(PANE)).toBe(false)
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
    // The renderer's confirmed-shell route calls agentStatus:drop FIRST, which deliberately mints a
    // providerSessionOnly remnant, then this. That remnant carries no state claim — it cannot gate a
    // pane `working` — and the pane's PTY is still there to resume into, so retiring the pane's live
    // claims must not take it. Without the option it goes with everything else.
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
      // The live claims still went: a latch left behind would re-gate the pane on its next event.
      expect(server._getStateForTests().claudeRunningNonAgentTaskPaneKeys.has(PANE)).toBe(false)

      // The retained identity must not recreate dead launch authority after restart.
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
    } finally {
      server.stop()
    }
  })
})
