// When an event borrows a previous row's provider session, and when it must not.

import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'
import { buildAgentResumeStartupPlan } from '../../shared/tui-agent-startup'
import { sanitizeHydratedEntry } from './server/server-persistence-validation'
import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

const servers: AgentHookServer[] = []
const directories: string[] = []

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

async function startServer(directory?: string): Promise<AgentHookServer> {
  const userDataPath = directory ?? mkdtempSync(join(tmpdir(), 'orca-resume-owner-'))
  if (!directory) {
    directories.push(userDataPath)
  }
  const server = new AgentHookServer()
  servers.push(server)
  await server.start({ env: 'production', userDataPath })
  return server
}

function statusFile(): string {
  const directory = directories.at(-1)
  if (!directory) {
    throw new Error('No server directory')
  }
  return join(directory, 'agent-hooks', 'last-status.json')
}

function claudeResumeCommand(session: AgentProviderSessionMetadata | undefined): string | null {
  if (!session) {
    return null
  }
  return (
    buildAgentResumeStartupPlan({
      agent: 'claude',
      providerSession: session,
      cmdOverrides: {},
      platform: 'linux'
    })?.launchCommand ?? null
  )
}

describe('resume owner rule', () => {
  it('lets Codex started after a Claude exit remnant keep its own session', async () => {
    const server = await startServer()
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        source: 'claude',
        hookEventName: 'UserPromptSubmit',
        launchToken: 'dead-launch-token',
        providerSession: { key: 'session_id', id: 'claude-exited' },
        payload: { state: 'working', prompt: 'review the PR', agentType: 'claude' }
      },
      'conn-a'
    )
    // Claude exits mid-turn while its shell lives on: only the retained identity row remains.
    server.dropStatusEntry(PANE)
    server.reconcileEndedProcessForPaneKeys([PANE], { preserveResumeIdentity: true })
    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      providerSessionOnly: true,
      providerSession: { id: 'claude-exited' }
    })

    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        source: 'codex',
        hookEventName: 'UserPromptSubmit',
        providerSession: { key: 'session_id', id: 'codex-new' },
        payload: { state: 'working', prompt: 'new codex work', agentType: 'codex' }
      },
      'conn-a'
    )
    const row = server.getStatusSnapshotForPane(PANE)[0]
    expect(row?.providerSession).toMatchObject({
      id: 'codex-new',
      resumeIdentity: { agent: 'codex' }
    })
    expect(claudeResumeCommand(row?.providerSession)).toBe(
      "codex '--dangerously-bypass-approvals-and-sandbox' 'resume' 'codex-new'"
    )
  })

  it.each([undefined, 'unknown'])(
    'does not re-attach a finished session to a terminal update naming %s',
    (agentType) => {
      const server = new AgentHookServer()
      servers.push(server)
      server.ingestRemote(
        {
          paneKey: PANE,
          source: 'claude',
          providerSession: { key: 'session_id', id: 'claude-finished' },
          payload: { state: 'done', prompt: 'first', agentType: 'claude' }
        },
        'conn-1'
      )
      server.ingestTerminalStatus({
        paneKey: PANE,
        connectionId: 'conn-1',
        payload: { state: 'working', prompt: 'second', ...(agentType ? { agentType } : {}) }
      })
      expect(server.getStatusSnapshot()[0]?.providerSession).toBeUndefined()
    }
  )

  it('keeps a borrowed legacy Claude session resumable after a restart', async () => {
    const first = await startServer()
    await postHookEvent(
      first,
      buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'go', session_id: 'claude-A' })
    )
    first.flushStatusPersistSync()
    first.stop()
    // What origin/main persists for a row last written by a terminal update: no source, no identity.
    const saved = JSON.parse(readFileSync(statusFile(), 'utf8'))
    delete saved.entries[PANE].source
    delete saved.entries[PANE].providerSession.resumeIdentity
    writeFileSync(statusFile(), JSON.stringify(saved))

    const second = await startServer(directories.at(-1))
    second.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      connectionId: null,
      payload: { state: 'working', prompt: 'go on', agentType: 'claude' }
    })
    await postHookEvent(
      second,
      buildBody({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'nested',
        session_id: 'codex-child'
      }),
      '/hook/codex'
    )
    const live = second.getStatusSnapshot().find((entry) => entry.paneKey === PANE)
    expect(live?.agentType).toBe('claude')
    expect(claudeResumeCommand(live?.providerSession)).toContain('claude-A')

    second.flushStatusPersistSync()
    const persisted = JSON.parse(readFileSync(statusFile(), 'utf8')).entries[PANE]
    expect(persisted.source).toBe('codex')
    const rehydrated = sanitizeHydratedEntry(PANE, persisted)
    expect(rehydrated?.providerSession?.resumeIdentity).toEqual({ agent: 'claude' })
    expect(claudeResumeCommand(rehydrated?.providerSession)).toContain('claude-A')
  })

  it('keeps the Claude session for a subagent event after a terminal update withheld it', () => {
    const server = new AgentHookServer()
    servers.push(server)
    const claudeEvent = (
      hookEventName: string,
      state: 'working' | 'done',
      toolAgentId?: string
    ) => ({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      source: 'claude',
      hookEventName,
      ...(toolAgentId ? { toolAgentId } : {}),
      providerSession: { key: 'session_id', id: 'claude-A' },
      payload: { state, prompt: 'p', agentType: 'claude' }
    })
    server.ingestRemote(claudeEvent('Stop', 'done'), 'conn-a')
    // A new turn after done starts clean: terminal ingest withholds the finished session.
    server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      connectionId: 'conn-a',
      payload: { state: 'working', prompt: 'q', agentType: 'claude' }
    })
    expect(server.getStatusSnapshotForPane(PANE)[0]?.providerSession).toBeUndefined()

    server.ingestRemote(claudeEvent('PreToolUse', 'working', 'sub-1'), 'conn-a')
    expect(server.getStatusSnapshotForPane(PANE)[0]?.providerSession).toMatchObject({
      id: 'claude-A',
      resumeIdentity: { agent: 'claude' }
    })
  })

  it('stores no session when the owner has none and a nested Codex event arrives', () => {
    const server = new AgentHookServer()
    servers.push(server)
    server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      connectionId: 'conn-a',
      payload: { state: 'working', prompt: 'q', agentType: 'claude' }
    })
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        source: 'codex',
        hookEventName: 'UserPromptSubmit',
        providerSession: { key: 'session_id', id: 'codex-child' },
        payload: { state: 'working', prompt: 'nested', agentType: 'codex' }
      },
      'conn-a'
    )
    const row = server.getStatusSnapshotForPane(PANE)[0]
    expect(row?.agentType).toBe('claude')
    expect(row?.providerSession).toBeUndefined()
  })
})
