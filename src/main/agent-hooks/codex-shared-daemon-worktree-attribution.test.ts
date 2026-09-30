import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { makePaneKey } from '../../shared/stable-pane-id'
import { registerPty, unregisterPty } from '../memory/pty-registry'
import { attachRuntimeWorktreeAgentRows } from '../runtime/runtime-worktree-agent-rows'
import { collectRuntimeWorktreeAgentSources } from '../runtime/runtime-worktree-agent-sources'
import { buildRuntimeWorktreeSummaryPathIndex } from '../runtime/runtime-worktree-summary-paths'
import type { RuntimeWorktreePsSummary } from '../../shared/runtime-types'
import type { ProcessIdentityRow } from '../opencode/opencode-client-sweep'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
// Why mock the sweep: the fake host process table decides which panes run a Codex TUI.
let hostProcesses: ProcessIdentityRow[] = []
vi.mock('../opencode/opencode-client-sweep', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sweepProcessIdentities: vi.fn(async () => hostProcesses)
}))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))

type Pane = {
  worktreeId: string
  tabId: string
  paneKey: string
  cwd: string
  sessionId: string
  ptyId: string
  shellPid: number
}

// Two Orca panes in two worktrees, each running its own Codex TUI on one shared daemon.
const SR: Pane = {
  worktreeId: 'repo::/work/StudentRegistration',
  tabId: 'tab-sr',
  paneKey: makePaneKey('tab-sr', '11111111-1111-4111-8111-111111111111'),
  cwd: '/work/StudentRegistration',
  sessionId: '01a0e331-a60e-7ba2-0000-000000000001',
  ptyId: 'pty-sr',
  shellPid: 1100
}
const MAC: Pane = {
  worktreeId: 'repo::/work/MacOS',
  tabId: 'tab-mac',
  paneKey: makePaneKey('tab-mac', '22222222-2222-4222-8222-222222222222'),
  cwd: '/work/MacOS',
  sessionId: '01a0e331-d459-7a92-0000-000000000002',
  ptyId: 'pty-mac',
  shellPid: 2200
}
// A plain shell split next to StudentRegistration's Codex pane (dev server, git, ...).
const SR_SHELL: Pane = {
  ...SR,
  paneKey: makePaneKey('tab-sr', '33333333-3333-4333-8333-333333333333'),
  ptyId: 'pty-sr-shell',
  shellPid: 3300
}

/** Host process table: a `codex` TUI under each listed pane's shell, plus the shared daemon. */
function runCodexIn(panes: Pane[]): void {
  hostProcesses = [
    ...panes.map((pane) => ({
      pid: pane.shellPid + 1,
      ppid: pane.shellPid,
      startedAtMs: 0,
      executable: '/opt/homebrew/bin/codex',
      argv: ['codex']
    })),
    {
      pid: 9000,
      ppid: 1,
      startedAtMs: 0,
      executable: '/opt/homebrew/bin/codex',
      argv: ['codex', 'app-server', '--managed-daemon']
    }
  ]
}

function registerPane(pane: Pane, paneKey: string | null = pane.paneKey): void {
  registerPty({
    ptyId: pane.ptyId,
    worktreeId: pane.worktreeId,
    sessionId: pane.ptyId,
    paneKey,
    pid: pane.shellPid
  })
}

/** Post the way the managed script does when Codex's shared daemon runs it. */
async function postDaemonCodexHook(
  server: AgentHookServer,
  // The daemon's env: the pane that started the daemon, whatever session fired the hook.
  daemonEnv: Pane,
  session: Pane,
  payload: Record<string, unknown>,
  cwd = session.cwd
): Promise<void> {
  const env = server.buildPtyEnv()
  const res = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/codex`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
    },
    body: new URLSearchParams({
      paneKey: daemonEnv.paneKey,
      tabId: daemonEnv.tabId,
      worktreeId: daemonEnv.worktreeId,
      env: 'production',
      executor: 'codex-shared-daemon',
      payload: JSON.stringify({ session_id: session.sessionId, cwd, ...payload })
    }).toString()
  })
  expect(res.status).toBeLessThan(300)
}

function psSummary(pane: Pane): RuntimeWorktreePsSummary {
  return {
    worktreeId: pane.worktreeId,
    repoId: 'repo',
    repo: 'repo',
    path: pane.cwd,
    branch: pane.tabId,
    isArchived: false,
    isMainWorktree: false,
    hasHostSidebarActivity: false,
    parentWorktreeId: null,
    childWorktreeIds: [],
    displayName: pane.tabId,
    workspaceStatus: 'active',
    sortOrder: 0,
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    comment: '',
    isPinned: false,
    isActive: false,
    unread: false,
    liveTerminalCount: 1,
    hasAttachedPty: true,
    lastOutputAt: null,
    preview: '',
    status: 'inactive',
    agents: []
  }
}

/** `orca worktree ps` rows built from the hook store, with both panes connected. */
function worktreePs(server: AgentHookServer): Map<string, RuntimeWorktreePsSummary> {
  const summaries = new Map(
    [SR, MAC].map((pane): [string, RuntimeWorktreePsSummary] => [pane.worktreeId, psSummary(pane)])
  )
  attachRuntimeWorktreeAgentRows({
    summaries,
    pathIndex: buildRuntimeWorktreeSummaryPathIndex(summaries, [], new Map()),
    missingWorktreeIds: new Set(),
    workingTerminalEvidenceByWorktreeId: new Map(),
    rowSources: collectRuntimeWorktreeAgentSources({
      mirroredWorktreeIdByTabId: new Map(),
      connectedPtyEvidence: {
        tabIds: new Set([SR.tabId, MAC.tabId]),
        paneKeys: new Set([SR.paneKey, MAC.paneKey]),
        ptyIdByTerminalHandle: new Map()
      },
      hookSnapshots: server.getStatusSnapshot()
    }),
    orchestrationByPaneKey: null,
    getSummary: (map, _path, _missing, id) => map.get(id) ?? null
  })
  return summaries
}

function agentsOf(ps: Map<string, RuntimeWorktreePsSummary>, pane: Pane) {
  return (ps.get(pane.worktreeId)?.agents ?? []).map((agent) => ({
    paneKey: agent.paneKey,
    state: agent.state,
    prompt: agent.prompt
  }))
}

describe('Codex hooks run by the shared app-server daemon', () => {
  let server: AgentHookServer

  beforeEach(async () => {
    _internals.resetCachesForTests()
    for (const pane of [SR, SR_SHELL, MAC]) {
      registerPane(pane)
    }
    server = new AgentHookServer()
    runCodexIn([SR, MAC])
    await server.start({ env: 'production' })
  })

  afterEach(() => {
    server.stop()
    for (const pane of [SR, SR_SHELL, MAC]) {
      unregisterPty(pane.ptyId)
    }
  })

  it('files each session under its own worktree, not the daemon starter pane', async () => {
    // MacOS started Codex first, so the daemon carries its ORCA_* env for every session.
    await postDaemonCodexHook(server, MAC, MAC, { hook_event_name: 'SessionStart' })
    await postDaemonCodexHook(server, MAC, MAC, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'previous MacOS task'
    })
    await postDaemonCodexHook(server, MAC, MAC, { hook_event_name: 'Stop' })

    await postDaemonCodexHook(server, MAC, SR, { hook_event_name: 'SessionStart' })
    await postDaemonCodexHook(server, MAC, SR, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'LATEST StudentRegistration prompt'
    })

    const ps = worktreePs(server)
    // Why SR has a shell split too: only the pane running Codex may inherit the session.
    expect(agentsOf(ps, SR)).toEqual([
      { paneKey: SR.paneKey, state: 'working', prompt: 'LATEST StudentRegistration prompt' }
    ])
    expect(agentsOf(ps, MAC)).toEqual([
      { paneKey: MAC.paneKey, state: 'done', prompt: 'previous MacOS task' }
    ])
  })

  it('keeps the only Codex session when it was launched outside its worktree', async () => {
    runCodexIn([MAC])
    await postDaemonCodexHook(
      server,
      MAC,
      MAC,
      { hook_event_name: 'UserPromptSubmit', prompt: 'codex -C ~/other' },
      '/Users/me/other'
    )

    const ps = worktreePs(server)
    expect(agentsOf(ps, MAC)).toEqual([
      { paneKey: MAC.paneKey, state: 'working', prompt: 'codex -C ~/other' }
    ])
    expect(agentsOf(ps, SR)).toEqual([])
  })

  it('drops a session outside every worktree when two Codex panes could own it', async () => {
    await postDaemonCodexHook(
      server,
      SR,
      MAC,
      { hook_event_name: 'UserPromptSubmit', prompt: 'prompt from elsewhere' },
      '/somewhere/else'
    )

    const ps = worktreePs(server)
    expect(agentsOf(ps, SR)).toEqual([])
    expect(agentsOf(ps, MAC)).toEqual([])
  })

  it('after an Orca restart, keeps the starter session before panes re-register', async () => {
    // Boot hydration registers the surviving terminal-daemon PTYs without pane keys.
    for (const pane of [SR, SR_SHELL, MAC]) {
      registerPane(pane, null)
    }
    await postDaemonCodexHook(server, MAC, MAC, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'MacOS after restart'
    })
    await postDaemonCodexHook(server, MAC, SR, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'StudentRegistration after restart'
    })

    const ps = worktreePs(server)
    expect(agentsOf(ps, MAC)).toEqual([
      { paneKey: MAC.paneKey, state: 'working', prompt: 'MacOS after restart' }
    ])
    expect(agentsOf(ps, SR)).toEqual([])
  })
})
