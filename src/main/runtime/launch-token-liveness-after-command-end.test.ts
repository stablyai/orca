import { createHash } from 'node:crypto'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../agent-hooks/server'
import {
  endCommand,
  launchAgentPane,
  liveRow,
  postHook,
  wireCommandEndHost,
  type CommandEndHost
} from './command-end-host-wiring.test-fixture'

// A launch token lives in the shell's environment, so every process started after the launched
// agent's command ended inherits it. Its authority ends at that command end, and no later write —
// a hook, the Codex transcript poll, a reconnect, the persisted file — may vouch for it again.

vi.mock('../git/worktree', () => {
  const worktrees = [
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/retirement-clear',
      isBare: false,
      isMainWorktree: false
    }
  ]
  return {
    listWorktrees: vi.fn().mockResolvedValue(worktrees),
    listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
  }
})

const teardowns: (() => void)[] = []

afterEach(() => {
  for (const teardown of teardowns.splice(0)) {
    teardown()
  }
  vi.restoreAllMocks()
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  teardowns.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A host whose agent still owns the foreground: every command end is a leaked one. */
async function wireLiveAgentHost(userDataPath?: string): Promise<CommandEndHost> {
  const host = await wireCommandEndHost(userDataPath ? { userDataPath } : {})
  teardowns.push(host.teardown)
  host.shellProof.mockResolvedValue('other')
  return host
}

async function restart(userDataPath: string, previous: AgentHookServer): Promise<AgentHookServer> {
  previous.flushStatusPersistSync()
  previous.stop()
  const restarted = new AgentHookServer()
  teardowns.push(() => restarted.stop())
  await restarted.start({ env: 'production', userDataPath })
  return restarted
}

function attest(
  server: AgentHookServer,
  pane: { paneKey: string; launchToken: string },
  terminalProvenance: 'current_runtime' | 'restored'
) {
  return server.attestCompatibilityAuthority({
    paneKey: pane.paneKey,
    launchTokenHash: createHash('sha256').update(pane.launchToken).digest('hex'),
    connectionId: null,
    terminalProvenance
  })
}

type RuntimeRecords = {
  ptysById: Map<string, { connected: boolean; connectionId: string | null }>
  dropDisconnectedPtyRecord: (ptyId: string) => void
}

function runtimeRecords(host: CommandEndHost): RuntimeRecords {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ptysById and dropDisconnectedPtyRecord are the runtime's protected PTY record members; a relay drop, an inventory miss and the record prune act on exactly these.
  return host.runtime as unknown as RuntimeRecords
}

function setPtyConnected(host: CommandEndHost, ptyId: string, connected: boolean): void {
  runtimeRecords(host).ptysById.get(ptyId)!.connected = connected
}

describe('the launch token a shell keeps after its command ends', () => {
  it('never vouches for a later process that inherits it, before or after a restart', async () => {
    const userDataPath = tempDir('orca-inherited-token-')
    const host = await wireLiveAgentHost(userDataPath)
    const pane = await launchAgentPane(host, 'pty-inherited-token')
    await postHook(host.server, 'claude', pane, {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'claude-session',
      prompt: 'review the PR'
    })
    expect(attest(host.server, pane, 'current_runtime')).not.toBeNull()

    await endCommand(host.runtime, pane.ptyId, 'daemon fact')
    // A new process posts with the token it inherited from the shell's environment.
    await postHook(host.server, 'claude', pane, {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'second-session',
      prompt: 'a different task'
    })

    expect(liveRow(host.server, pane.paneKey)?.prompt).toBe('a different task')
    expect(liveRow(host.server, pane.paneKey)?.launchToken).toBeUndefined()
    expect(attest(host.server, pane, 'current_runtime')).toBeNull()

    const restarted = await restart(userDataPath, host.server)
    expect(restarted.getHydratedAuthorityCommitments()).toHaveLength(0)
    expect(attest(restarted, pane, 'restored')).toBeNull()
  })

  it('is not persisted from the row the live agent wrote before its command ended', async () => {
    const userDataPath = tempDir('orca-row-token-')
    const host = await wireLiveAgentHost(userDataPath)
    const pane = await launchAgentPane(host, 'pty-row-token')
    await postHook(host.server, 'claude', pane, {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'claude-session',
      prompt: 'review the PR'
    })

    await endCommand(host.runtime, pane.ptyId, 'shell bytes')

    const restarted = await restart(userDataPath, host.server)
    expect(restarted.getHydratedAuthorityCommitments()).toHaveLength(0)
    expect(attest(restarted, pane, 'restored')).toBeNull()
  })

  it('is not re-minted while the PTY record reads disconnected', async () => {
    const userDataPath = tempDir('orca-disconnected-token-')
    const host = await wireLiveAgentHost(userDataPath)
    const pane = await launchAgentPane(host, 'pty-disconnected-token')
    await postHook(host.server, 'claude', pane, {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'claude-session',
      prompt: 'review the PR'
    })
    await endCommand(host.runtime, pane.ptyId, 'shell bytes')

    // A relay drop or inventory miss marks the record disconnected; the agent keeps posting.
    setPtyConnected(host, pane.ptyId, false)
    await postHook(host.server, 'claude', pane, {
      hook_event_name: 'PreToolUse',
      session_id: 'claude-session',
      tool_name: 'Bash'
    })
    expect(attest(host.server, pane, 'current_runtime')).toBeNull()
    setPtyConnected(host, pane.ptyId, true)
    await postHook(host.server, 'claude', pane, {
      hook_event_name: 'Stop',
      session_id: 'claude-session'
    })

    expect(liveRow(host.server, pane.paneKey)?.launchToken).toBeUndefined()
    expect(attest(host.server, pane, 'current_runtime')).toBeNull()
    const restarted = await restart(userDataPath, host.server)
    expect(restarted.getHydratedAuthorityCommitments()).toHaveLength(0)
    expect(attest(restarted, pane, 'restored')).toBeNull()
  })

  it('is not persisted once the runtime prunes the PTY record of a kept SSH row', async () => {
    const userDataPath = tempDir('orca-pruned-record-token-')
    const host = await wireLiveAgentHost(userDataPath)
    const pane = await launchAgentPane(host, 'pty-pruned-record-token')
    await postHook(host.server, 'claude', pane, {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'claude-session',
      prompt: 'review the PR'
    })
    await endCommand(host.runtime, pane.ptyId, 'shell bytes')

    // An SSH record pruned after an unverifiable disconnect: its host-owned row survives.
    const record = runtimeRecords(host).ptysById.get(pane.ptyId)!
    record.connectionId = 'conn-ssh'
    record.connected = false
    runtimeRecords(host).dropDisconnectedPtyRecord(pane.ptyId)
    expect(liveRow(host.server, pane.paneKey)?.state).toBe('working')

    const restarted = await restart(userDataPath, host.server)
    expect(restarted.getHydratedAuthorityCommitments()).toHaveLength(0)
    expect(attest(restarted, pane, 'restored')).toBeNull()
  })

  it('still vouches for the agent it was minted for while that agent runs', async () => {
    const host = await wireLiveAgentHost()
    const pane = await launchAgentPane(host, 'pty-live-token')
    await postHook(host.server, 'claude', pane, {
      hook_event_name: 'PreToolUse',
      session_id: 'claude-session',
      tool_name: 'Bash'
    })

    expect(liveRow(host.server, pane.paneKey)?.launchToken).toBe(pane.launchToken)
    expect(attest(host.server, pane, 'current_runtime')).not.toBeNull()
  })
})

const CHILD_ID = '019fa65f-3144-7151-9c02-cff7a28f316f'
const SECOND_CHILD_ID = '019fa65f-3144-7151-9c02-cff7a28f3170'

function transcriptLine(record: unknown): string {
  return `${JSON.stringify(record)}\n`
}

function spawnLine(threadId: string, agentPath: string): string {
  return transcriptLine({
    type: 'event_msg',
    payload: {
      type: 'sub_agent_activity',
      occurred_at_ms: 1234,
      agent_thread_id: threadId,
      agent_path: agentPath,
      kind: 'started'
    }
  })
}

describe('a live Codex lead after a leaked command end', () => {
  it('keeps polling its transcript, and the poll cannot bring the token back', async () => {
    const userDataPath = tempDir('orca-codex-poll-')
    const transcripts = tempDir('orca-codex-rollout-')
    const parentPath = join(transcripts, 'rollout-parent.jsonl')
    const started = transcriptLine({ type: 'event_msg', payload: { type: 'task_started' } })
    writeFileSync(parentPath, spawnLine(CHILD_ID, '/root/pr_review'))
    writeFileSync(join(transcripts, `rollout-child-${CHILD_ID}.jsonl`), started)
    writeFileSync(join(transcripts, `rollout-child-${SECOND_CHILD_ID}.jsonl`), started)
    const host = await wireLiveAgentHost(userDataPath)
    const pane = await launchAgentPane(host, 'pty-codex-poll', 'codex')
    await postHook(host.server, 'codex', pane, {
      hook_event_name: 'PostToolUse',
      session_id: 'root-session',
      transcript_path: parentPath,
      tool_name: 'collaborationspawn_agent'
    })
    expect(liveRow(host.server, pane.paneKey)?.subagents).toHaveLength(1)

    await endCommand(host.runtime, pane.ptyId, 'shell bytes')
    appendFileSync(parentPath, spawnLine(SECOND_CHILD_ID, '/root/perf_audit'))

    await vi.waitFor(() => expect(liveRow(host.server, pane.paneKey)?.subagents).toHaveLength(2), {
      timeout: 3_000,
      interval: 50
    })
    expect(liveRow(host.server, pane.paneKey)?.launchToken).toBeUndefined()
    expect(attest(host.server, pane, 'current_runtime')).toBeNull()
    const restarted = await restart(userDataPath, host.server)
    expect(restarted.getHydratedAuthorityCommitments()).toHaveLength(0)
    expect(attest(restarted, pane, 'restored')).toBeNull()
  })
})
