import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginCapabilityKind } from '../../../../shared/plugins/capabilities/plugin-capabilities'
import { PLUGIN_HOST_API } from '../../../../shared/plugins/workers/plugin-host-api'
import { PluginRuntimeRpcError } from '../../plugin-runtime-rpc'
import { callPluginHost, pluginHostTestServices } from './__mocks__/plugin-host-services-fixture'
import { PLUGIN_HISTORY_TTL_MS } from './plugin-agent-history'
import type { PluginRuntimeRpc } from './plugin-host-runtime-call'
import type { PluginHostServices } from './plugin-host-method-bindings'
import type { PluginAgentStatusRow } from './plugin-workspace-projection'

const WORKTREES = {
  worktrees: [
    // A project's own folder, with a worktree nested inside it.
    { id: 'r1::/src/r1', repoId: 'r1', displayName: 'r1', path: '/src/r1', hostId: 'local' },
    {
      id: 'r1::/src/r1/.worktrees/seal',
      repoId: 'r1',
      displayName: 'seal',
      path: '/src/r1/.worktrees/seal',
      hostId: 'local',
      identity: { key: 'wt2:local:seal' }
    },
    // The same path on an SSH machine is another computer's folder.
    { id: 'r2::/src/r1', repoId: 'r2', displayName: 'remote', path: '/src/r1', hostId: 'ssh:box' }
  ]
}
const FOLDERS = {
  folderWorkspaces: [{ id: 'notes', name: 'Notes', folderPath: '/notes', executionHostId: null }]
}

function vaultRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row',
    executionHostId: 'local',
    agent: 'claude',
    sessionId: 's-1',
    title: 'Fix the login\n  page',
    cwd: '/src/r1/.worktrees/seal/app',
    branch: 'refs/heads/seal',
    model: 'opus',
    filePath: '/home/me/.claude/projects/x/s-1.jsonl',
    codexHome: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    modifiedAt: '2026-01-02T00:00:00.000Z',
    messageCount: 12,
    totalTokens: 3400,
    previewMessages: [{ role: 'user', text: 'secret prompt', timestamp: null }],
    firstUserPrompt: 'secret prompt',
    lastUserPrompt: 'another secret',
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: 'claude --resume s-1',
    subagent: null,
    ...overrides
  }
}

function runtime(answers: Record<string, unknown> = {}) {
  const all: Record<string, unknown> = {
    'worktree.list': WORKTREES,
    'repo.list': {
      repos: [
        { id: 'r1', kind: 'git' },
        { id: 'r2', connectionId: 'box' }
      ]
    },
    'folderWorkspace.list': FOLDERS,
    'aiVault.listSessions': {
      sessions: [vaultRow()],
      issues: [],
      scannedAt: 'x',
      fingerprint: 'f1'
    },
    ...answers
  }
  return vi.fn<PluginRuntimeRpc>(async (method, params) => {
    const answer = all[method]
    if (answer instanceof Error) {
      throw answer
    }
    return typeof answer === 'function' ? answer(params) : answer
  })
}

const listSessions = (
  rpc: PluginRuntimeRpc,
  params: unknown = {},
  overrides: Partial<PluginHostServices> = {},
  granted: PluginCapabilityKind[] = ['history:read']
) =>
  callPluginHost({
    method: 'agent.listSessions',
    params,
    granted,
    services: pluginHostTestServices(rpc, overrides)
  })

const vaultCalls = (rpc: ReturnType<typeof runtime>) =>
  rpc.mock.calls.filter(([method]) => method === 'aiVault.listSessions').map(([, params]) => params)

afterEach(() => {
  vi.useRealTimers()
})

describe('agent.listSessions', () => {
  it('needs history:read', async () => {
    const rpc = runtime()
    expect(await listSessions(rpc, {}, {}, ['agent:read'])).toMatchObject({
      ok: false,
      code: 'capability_denied'
    })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('gives public fields only: no messages, prompts, file paths or account homes', async () => {
    const rpc = runtime({
      'aiVault.listSessions': {
        sessions: [
          vaultRow({ title: `${'x'.repeat(600)}\nmore`, agent: 'codex', codexHome: '/h/.codex' }),
          // A subagent transcript is its parent's; an id agent.resume would refuse is left out.
          vaultRow({ sessionId: 'child', subagent: { parentSessionId: 's-1' } }),
          vaultRow({ sessionId: '--all' })
        ],
        issues: [],
        scannedAt: 'x'
      }
    })
    const outcome = await listSessions(rpc)
    const parsed = PLUGIN_HOST_API['agent.listSessions'].result.safeParse(
      outcome.ok ? outcome.value : null
    )
    const sessions = parsed.success ? parsed.data.sessions : []
    expect(sessions).toHaveLength(1)
    const [session] = sessions
    expect(Object.keys(session).toSorted()).toEqual(
      [
        'agent',
        'branch',
        'createdAt',
        'hostId',
        'messageCount',
        'running',
        'sessionId',
        'title',
        'totalTokens',
        'updatedAt',
        'workspaceId'
      ].toSorted()
    )
    expect(session).toMatchObject({
      agent: 'codex',
      branch: 'seal',
      createdAt: Date.parse('2026-01-01T00:00:00.000Z'),
      updatedAt: Date.parse('2026-01-02T00:00:00.000Z'),
      hostId: 'local'
    })
    expect(session.title).toHaveLength(512)
    expect(JSON.stringify(outcome)).not.toMatch(/secret|\.jsonl|\/h\/\.codex|resume/)
  })

  it('maps each session to the deepest workspace on this computer, never an SSH twin', async () => {
    const rpc = runtime({
      'aiVault.listSessions': {
        sessions: [
          vaultRow({ sessionId: 'nested', updatedAt: '2026-01-05T00:00:00.000Z' }),
          vaultRow({
            sessionId: 'project',
            cwd: '/src/r1/docs',
            updatedAt: '2026-01-04T00:00:00.000Z'
          }),
          vaultRow({ sessionId: 'folder', cwd: '/notes', updatedAt: '2026-01-03T00:00:00.000Z' }),
          vaultRow({ sessionId: 'elsewhere', cwd: '/tmp', updatedAt: '2026-01-02T00:00:00.000Z' })
        ],
        issues: [],
        scannedAt: 'x'
      }
    })
    const outcome = await listSessions(rpc)
    expect(outcome.ok && outcome.value).toEqual({
      sessions: [
        expect.objectContaining({ sessionId: 'nested', workspaceId: 'identity:wt2:local:seal' }),
        expect.objectContaining({ sessionId: 'project', workspaceId: 'r1::/src/r1' }),
        expect.objectContaining({ sessionId: 'folder', workspaceId: 'folder:notes' }),
        expect.objectContaining({ sessionId: 'elsewhere', workspaceId: null })
      ],
      truncated: false
    })
    // One depth for every caller; previews never asked for.
    expect(vaultCalls(rpc)).toEqual([{ limit: 200, afterFingerprint: null }])
  })

  it("reads one workspace's sessions by its folder, leaving those of worktrees nested in it", async () => {
    const rpc = runtime({
      'aiVault.listSessions': {
        sessions: [
          vaultRow({ sessionId: 'nested' }),
          vaultRow({ sessionId: 'own', cwd: '/src/r1' })
        ],
        issues: [],
        scannedAt: 'x'
      }
    })
    const outcome = await listSessions(rpc, { workspaceId: 'r1::/src/r1' })
    expect(outcome.ok && outcome.value).toEqual({
      sessions: [expect.objectContaining({ sessionId: 'own', workspaceId: 'r1::/src/r1' })],
      truncated: false
    })
    expect(vaultCalls(rpc)).toEqual([
      { limit: 200, scopePaths: ['/src/r1'], scopeOnly: true, afterFingerprint: null }
    ])
  })

  it('answers no sessions for an SSH workspace, whose history is not on this computer', async () => {
    const rpc = runtime()
    expect(await listSessions(rpc, { workspaceId: 'r2::/src/r1' })).toEqual({
      ok: true,
      value: { sessions: [], truncated: false }
    })
    expect(vaultCalls(rpc)).toEqual([])
  })

  it('refuses an unknown workspace with a fixed message', async () => {
    const rpc = runtime({
      'worktree.show': new PluginRuntimeRpcError('selector_not_found', 'no match for /x')
    })
    expect(await listSessions(rpc, { workspaceId: 'r9::/x' })).toEqual({
      ok: false,
      code: 'action_failed',
      error: 'no workspace has this id'
    })
  })

  it('marks sessions an Orca pane on this computer runs, and reports truncation', async () => {
    const running = (connectionId: string | null, id: string): PluginAgentStatusRow => ({
      paneKey: `t:${id}`,
      state: 'working',
      stateStartedAt: 1,
      agentType: 'claude',
      connectionId,
      providerSession: { id }
    })
    const rpc = runtime({
      'aiVault.listSessions': {
        sessions: [vaultRow({ sessionId: 'a' }), vaultRow({ sessionId: 'b' })],
        issues: [],
        scannedAt: 'x'
      }
    })
    const outcome = await listSessions(
      rpc,
      { limit: 1 },
      { listAgentStatuses: () => [running(null, 'a'), running('box', 'b')] }
    )
    expect(outcome.ok && outcome.value).toEqual({
      sessions: [expect.objectContaining({ sessionId: 'a', running: true })],
      truncated: true
    })
  })

  it('shares one read among calls, then revalidates it by fingerprint', async () => {
    vi.useFakeTimers()
    const rpc = runtime({
      'aiVault.listSessions': (params: { afterFingerprint?: string }) =>
        params.afterFingerprint === 'f1'
          ? { sessions: [], issues: [], scannedAt: 'y', fingerprint: 'f1', unchanged: true }
          : { sessions: [vaultRow()], issues: [], scannedAt: 'x', fingerprint: 'f1' }
    })
    const [first, second] = await Promise.all([listSessions(rpc), listSessions(rpc)])
    expect(second).toEqual(first)
    expect(vaultCalls(rpc)).toHaveLength(1)
    vi.advanceTimersByTime(PLUGIN_HISTORY_TTL_MS + 1)
    // Unchanged history keeps the rows already read.
    expect(await listSessions(rpc)).toEqual(first)
    expect(vaultCalls(rpc)).toEqual([
      { limit: 200, afterFingerprint: null },
      { limit: 200, afterFingerprint: 'f1' }
    ])
  })

  it('does not keep a failed read', async () => {
    let fail = true
    const rpc = runtime({
      'aiVault.listSessions': () => {
        if (fail) {
          fail = false
          throw new PluginRuntimeRpcError('runtime_error', 'scan failed')
        }
        return { sessions: [vaultRow()], issues: [], scannedAt: 'x' }
      }
    })
    expect(await listSessions(rpc)).toMatchObject({ ok: false, code: 'action_failed' })
    expect(await listSessions(rpc)).toMatchObject({ ok: true })
  })
})

describe('agent.resume of a past session', () => {
  const resume = (rpc: PluginRuntimeRpc, agent = 'claude', statuses: PluginAgentStatusRow[] = []) =>
    callPluginHost({
      method: 'agent.resume',
      params: { workspaceId: 'identity:wt2:local:seal', agent, sessionId: 's-1' },
      granted: ['agent:launch'],
      services: pluginHostTestServices(rpc, { listAgentStatuses: () => statuses })
    })
  const pastRuntime = (answers: Record<string, unknown> = {}) =>
    runtime({
      'worktree.show': {
        worktree: {
          id: WORKTREES.worktrees[1].id,
          hostId: 'local',
          path: '/src/r1/.worktrees/seal'
        }
      },
      'aiVault.prepareSessionResume': { useRealCodexHome: false },
      'terminal.ensureAgentSession': { terminal: { handle: 'term_r' }, disposition: 'created' },
      ...answers
    })
  const paramsOf = (rpc: ReturnType<typeof runtime>, method: string) =>
    rpc.mock.calls.find(([name]) => name === method)?.[1]

  it('prepares it as Orca’s Resume does, and resumes from its transcript, with agent:launch only', async () => {
    const rpc = pastRuntime()
    expect(await resume(rpc)).toEqual({ ok: true, value: { terminalId: 'term_r', started: true } })
    // The workspace's own sessions are looked up first.
    expect(vaultCalls(rpc)[0]).toEqual({
      limit: 200,
      scopePaths: ['/src/r1/.worktrees/seal'],
      scopeOnly: true,
      afterFingerprint: null
    })
    expect(paramsOf(rpc, 'aiVault.prepareSessionResume')).toEqual({
      agent: 'claude',
      sessionId: 's-1',
      filePath: '/home/me/.claude/projects/x/s-1.jsonl',
      codexHome: null,
      executionHostId: 'local'
    })
    expect(paramsOf(rpc, 'terminal.ensureAgentSession')).toMatchObject({
      providerSession: {
        key: 'session_id',
        id: 's-1',
        transcriptPath: '/home/me/.claude/projects/x/s-1.jsonl'
      }
    })
  })

  it("passes a Codex session's managed home only where it needs readying", async () => {
    const home = '/u/.orca/codex-accounts/a1/home'
    const rpc = pastRuntime({
      'aiVault.listSessions': {
        sessions: [
          vaultRow({ agent: 'codex', codexHome: home, filePath: `${home}/sessions/r.jsonl` })
        ],
        issues: [],
        scannedAt: 'x'
      }
    })
    expect(await resume(rpc, 'codex')).toMatchObject({ ok: true })
    expect(paramsOf(rpc, 'aiVault.prepareSessionResume')).toMatchObject({ codexHome: home })
  })

  it('refuses when preparation fails, before any terminal opens', async () => {
    const rpc = pastRuntime({
      'aiVault.prepareSessionResume': new PluginRuntimeRpcError(
        'runtime_error',
        'This session is open in an Orca chat.'
      )
    })
    expect(await resume(rpc)).toEqual({
      ok: false,
      code: 'action_failed',
      error: 'Orca could not prepare this session to resume'
    })
    expect(paramsOf(rpc, 'terminal.ensureAgentSession')).toBeUndefined()
  })

  it('resumes by id, unprepared, when history lists no such session or cannot be read', async () => {
    for (const listing of [
      { sessions: [], issues: [], scannedAt: 'x' },
      new PluginRuntimeRpcError('runtime_error', 'scan failed')
    ]) {
      const rpc = pastRuntime({ 'aiVault.listSessions': listing })
      expect(await resume(rpc)).toMatchObject({ ok: true })
      expect(paramsOf(rpc, 'aiVault.prepareSessionResume')).toBeUndefined()
      expect(paramsOf(rpc, 'terminal.ensureAgentSession')).toMatchObject({
        providerSession: { key: 'session_id', id: 's-1' }
      })
      expect(paramsOf(rpc, 'terminal.ensureAgentSession')).not.toHaveProperty(
        'providerSession.transcriptPath'
      )
    }
  })

  it('leaves a live session and an SSH workspace out of history', async () => {
    const live = pastRuntime()
    await resume(live, 'claude', [
      {
        paneKey: 't:l',
        worktreeId: WORKTREES.worktrees[1].id,
        state: 'done',
        stateStartedAt: 1,
        agentType: 'claude',
        providerSession: { id: 's-1' }
      }
    ])
    const remote = pastRuntime({
      'worktree.show': { worktree: { id: 'r2::/src/r1', hostId: 'ssh:box', path: '/src/r1' } }
    })
    await resume(remote)
    for (const rpc of [live, remote]) {
      expect(vaultCalls(rpc)).toEqual([])
      expect(paramsOf(rpc, 'terminal.ensureAgentSession')).toMatchObject({
        providerSession: { id: 's-1' }
      })
    }
  })
})

describe('agents.list task', () => {
  it('names the dispatched task a pane runs, and null for one that runs none', async () => {
    const status = (paneKey: string, stateStartedAt: number): PluginAgentStatusRow => ({
      paneKey,
      worktreeId: 'r1::/w',
      state: 'working',
      stateStartedAt
    })
    const listAgentTaskTitles = vi.fn(() => new Map([['t:worker', 'Write the tests']]))
    const outcome = await callPluginHost({
      method: 'agents.list',
      params: {},
      granted: ['agent:read'],
      services: pluginHostTestServices(runtime(), {
        resolveActiveWorktreeContext: vi
          .fn()
          .mockResolvedValue({ worktreeId: 'r1::/w', branch: '', displayName: 'w' }),
        listAgentStatuses: () => [status('t:worker', 2), status('t:solo', 1)],
        listAgentTaskTitles
      })
    })
    expect(outcome.ok && outcome.value).toMatchObject({
      agents: [{ task: { title: 'Write the tests' } }, { task: null }]
    })
    expect(JSON.stringify(outcome)).not.toMatch(/dispatch/i)
  })

  it('does not read task titles for a workspace without agents', async () => {
    const listAgentTaskTitles = vi.fn(() => new Map<string, string>())
    await callPluginHost({
      method: 'agents.list',
      params: {},
      granted: ['agent:read'],
      services: pluginHostTestServices(runtime(), {
        resolveActiveWorktreeContext: vi
          .fn()
          .mockResolvedValue({ worktreeId: 'r1::/w', branch: '', displayName: 'w' }),
        listAgentTaskTitles
      })
    })
    expect(listAgentTaskTitles).not.toHaveBeenCalled()
  })
})
