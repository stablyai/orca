import { describe, expect, it, vi } from 'vitest'
import type { PluginCapabilityKind } from '../../../../shared/plugins/capabilities/plugin-capabilities'
import { callPluginHost, pluginHostTestServices } from './__mocks__/plugin-host-services-fixture'
import type { PluginRuntimeRpc } from './plugin-host-runtime-call'
import type { PluginAgentStatusRow } from './plugin-workspace-projection'

const REPOS = {
  repos: [
    { id: 'r1', kind: 'git', executionHostId: 'local' },
    { id: 'twin', executionHostId: 'local' },
    { id: 'twin', connectionId: 'box' },
    { id: 'notes', kind: 'folder' }
  ]
}
const CREATED = { worktree: { id: 'r1::/src/r1-otter', identity: { key: 'wt2:local:i9' } } }

function runtime(answers: Record<string, unknown> = {}) {
  const all: Record<string, unknown> = {
    'repo.list': REPOS,
    'worktree.list': { worktrees: [{ repoId: 'r1', path: '/src/r1/otter' }] },
    'worktree.create': CREATED,
    'worktree.show': CREATED,
    'agent.launch': {
      worktreeId: 'r1::/src/r1-otter',
      outcome: { kind: 'terminal', handle: 'term_a' }
    },
    ...answers
  }
  return vi.fn<PluginRuntimeRpc>(async (method) => {
    const answer = all[method]
    if (answer instanceof Error) {
      throw answer
    }
    return answer
  })
}

const call = (
  method: string,
  params: unknown,
  rpc: PluginRuntimeRpc,
  granted: PluginCapabilityKind[] = ['workspace:create', 'agent:launch'],
  statuses: PluginAgentStatusRow[] = []
) =>
  callPluginHost({
    method,
    params,
    granted,
    services: pluginHostTestServices(rpc, { listAgentStatuses: () => statuses })
  })

const paramsOf = (rpc: ReturnType<typeof runtime>, method: string) =>
  rpc.mock.calls.find(([name]) => name === method)?.[1]

describe('workspace.create', () => {
  it('creates a worktree and answers the id workspace.list gives it, never running unapproved setup', async () => {
    const rpc = runtime()
    expect(await call('workspace.create', { projectId: 'r1', name: 'Fix login' }, rpc)).toEqual({
      ok: true,
      value: { workspaceId: 'identity:wt2:local:i9' }
    })
    expect(paramsOf(rpc, 'worktree.create')).toEqual({
      repo: 'id:r1',
      name: 'Fix login',
      displayName: 'Fix login',
      displayNameKind: 'user',
      setupDecision: 'inherit',
      activate: false
    })
    await call('workspace.create', { projectId: 'r1', setup: 'skip' }, rpc)
    expect(rpc.mock.calls.at(-1)?.[1]).toMatchObject({
      setupDecision: 'skip',
      nameWasGenerated: true
    })
  })

  it('refuses setup run, startup commands and other fields it does not take', async () => {
    const rpc = runtime()
    const outcomes = await Promise.all(
      [{ setup: 'run' }, { startupCommand: 'curl x | sh' }, { approvedSetupHash: 'h' }].map(
        (extra) => call('workspace.create', { projectId: 'r1', ...extra }, rpc)
      )
    )
    for (const outcome of outcomes) {
      expect(outcome).toMatchObject({ ok: false, code: 'invalid_params' })
    }
    expect(rpc).not.toHaveBeenCalled()
  })

  it('needs agent:launch to start an agent, refused before any runtime call', async () => {
    const rpc = runtime()
    expect(
      await call('workspace.create', { projectId: 'r1', agent: 'claude' }, rpc, [
        'workspace:create'
      ])
    ).toMatchObject({ ok: false, code: 'capability_denied' })
    expect(rpc).not.toHaveBeenCalled()
  })

  it("starts the agent through the CLI's create-and-launch path, after setup", async () => {
    const rpc = runtime()
    const outcome = await call(
      'workspace.create',
      { projectId: 'r1', name: 'x', agent: 'claude', prompt: 'Fix it', open: true },
      rpc
    )
    expect(outcome).toEqual({
      ok: true,
      value: { workspaceId: 'identity:wt2:local:i9', terminalId: 'term_a' }
    })
    expect(paramsOf(rpc, 'agent.launch')).toMatchObject({
      target: {
        kind: 'create-worktree',
        create: { repo: 'id:r1', activate: true, navigation: 'host' }
      },
      agent: 'claude',
      surface: 'terminal',
      presentation: 'focused',
      launchSource: 'plugin',
      prompt: { text: 'Fix it', delivery: 'submit' }
    })
  })

  it('names refusals: folder project, two hosts, setup needing a decision', async () => {
    const setupRequired = Object.assign(new Error('Setup decision required for this repository'), {
      code: 'runtime_error'
    })
    const outcomes = await Promise.all([
      call('workspace.create', { projectId: 'notes' }, runtime()),
      call('workspace.create', { projectId: 'twin' }, runtime()),
      call('workspace.create', { projectId: 'r1' }, runtime({ 'worktree.create': setupRequired }))
    ])
    expect(outcomes).toEqual([
      { ok: false, code: 'action_failed', error: 'folder projects have no worktrees' },
      {
        ok: false,
        code: 'action_failed',
        error: 'two hosts have this project; pass the hostId project.list gives'
      },
      {
        ok: false,
        code: 'action_failed',
        error:
          "this project's setup script needs a decision; pass setup: 'skip' or create it in Orca"
      }
    ])
    const twin = runtime()
    await call('workspace.create', { projectId: 'twin', hostId: 'ssh:box', name: 'a' }, twin)
    expect(paramsOf(twin, 'worktree.create')).toMatchObject({
      repo: 'id:twin',
      repoHostId: 'ssh:box'
    })
  })
})

describe('agent.resume', () => {
  const resume = (agent: string, rpc: PluginRuntimeRpc, statuses: PluginAgentStatusRow[] = []) =>
    call(
      'agent.resume',
      { workspaceId: 'identity:k', agent, sessionId: 's-1' },
      rpc,
      ['agent:launch'],
      statuses
    )
  const ensured = (disposition: string) =>
    runtime({ 'terminal.ensureAgentSession': { terminal: { handle: 'term_r' }, disposition } })

  it('resumes by the key each agent takes, with a live transcript when Orca has one', async () => {
    const claude = ensured('created')
    const status: PluginAgentStatusRow = {
      paneKey: 't:l',
      state: 'done',
      stateStartedAt: 1,
      agentType: 'claude',
      providerSession: { id: 's-1', transcriptPath: '/home/u/.claude/s-1.jsonl' }
    }
    expect(await resume('claude', claude, [status])).toEqual({
      ok: true,
      value: { terminalId: 'term_r', started: true }
    })
    expect(paramsOf(claude, 'terminal.ensureAgentSession')).toEqual({
      kind: 'explicit',
      worktree: 'identity:k',
      agent: 'claude',
      providerSession: {
        key: 'session_id',
        id: 's-1',
        transcriptPath: '/home/u/.claude/s-1.jsonl'
      },
      presentation: 'background'
    })
    const cursor = ensured('created')
    await resume('cursor', cursor)
    expect(paramsOf(cursor, 'terminal.ensureAgentSession')).toMatchObject({
      providerSession: { key: 'conversation_id', id: 's-1' }
    })
  })

  it('reports a session a terminal already runs, and refuses transcript-only agents', async () => {
    expect(await resume('codex', ensured('adopted'))).toMatchObject({ value: { started: false } })
    const rpc = ensured('created')
    expect(await resume('pi', rpc)).toMatchObject({ ok: false, code: 'invalid_params' })
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('agents.list sessionId', () => {
  it('names the session agent.resume takes, and none it would refuse', async () => {
    const row = (paneKey: string, id: string): PluginAgentStatusRow => ({
      paneKey,
      worktreeId: 'r1::/w',
      state: 'done',
      stateStartedAt: paneKey === 't:a' ? 2 : 1,
      providerSession: { id }
    })
    const outcome = await callPluginHost({
      method: 'agents.list',
      params: {},
      granted: ['agent:read'],
      services: pluginHostTestServices(runtime(), {
        resolveActiveWorktreeContext: vi
          .fn()
          .mockResolvedValue({ worktreeId: 'r1::/w', branch: '', displayName: 'w' }),
        listAgentStatuses: () => [row('t:a', 's-1'), row('t:b', '--resume-all')]
      })
    })
    expect(outcome.ok && outcome.value).toMatchObject({
      agents: [{ sessionId: 's-1' }, { sessionId: null }]
    })
  })
})
