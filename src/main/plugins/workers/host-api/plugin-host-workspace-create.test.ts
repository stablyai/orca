import { describe, expect, it, vi } from 'vitest'
import type { PluginCapabilityKind } from '../../../../shared/plugins/capabilities/plugin-capabilities'
import { WorktreeCreateSetupChoiceRefusedError } from '../../../runtime/workspaces/creation/worktree-create-setup-choice-refusal'
import { PluginRuntimeRpcError } from '../../plugin-runtime-rpc'
import { callPluginHost, pluginHostTestServices } from './__mocks__/plugin-host-services-fixture'
import { isPluginOpenedTerminal } from './plugin-opened-terminals'
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
const OTTER = { id: 'r1::/src/r1-otter', identity: { key: 'wt2:local:i9' } }
const EXISTING = { id: 'r1::/src/r1/seal', repoId: 'r1', path: '/src/r1/seal', hostId: 'local' }

function runtime(answers: Record<string, unknown> = {}) {
  const all: Record<string, unknown> = {
    'repo.list': REPOS,
    'worktree.list': { worktrees: [EXISTING] },
    'worktree.create': { worktree: OTTER },
    'worktree.show': { worktree: { ...OTTER, hostId: 'local' } },
    'agent.launch': { worktreeId: OTTER.id, outcome: { kind: 'terminal', handle: 'term_a' } },
    ...answers
  }
  return vi.fn<PluginRuntimeRpc>(async (method) => {
    const answer = all[method]
    if (answer instanceof Error) {
      throw answer
    }
    return typeof answer === 'function' ? answer() : answer
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

// The in-process runtime's refusal, carrying the class the handler threw.
const refusedBy = (cause: Error) =>
  new PluginRuntimeRpcError('runtime_error', cause.message, { cause })

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
    // Every worktree of the project, unpaged, so a generated name is free across all of them.
    expect(paramsOf(rpc, 'worktree.list')).toEqual({ limit: Number.MAX_SAFE_INTEGER })
    await call('workspace.create', { projectId: 'r1', setup: 'skip' }, rpc)
    const generated = rpc.mock.calls.at(-1)?.[1]
    expect(generated).toMatchObject({ setupDecision: 'skip', nameWasGenerated: true })
    expect(generated).not.toMatchObject({ name: 'seal' })
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

  it("starts the agent through the CLI's create-and-launch path, and may close its terminal", async () => {
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
    expect(isPluginOpenedTerminal('samples.demo', 'term_a')).toBe(true)
  })

  it('names the workspace a failed launch left behind', async () => {
    let created = false
    const rpc = runtime({
      'worktree.list': () => ({
        worktrees: created
          ? [EXISTING, { ...OTTER, repoId: 'r1', path: '/src/r1-otter', hostId: 'local' }]
          : [EXISTING]
      }),
      'agent.launch': () => {
        created = true
        throw new PluginRuntimeRpcError('runtime_error', 'agent CLI not found')
      }
    })
    const outcome = await call('workspace.create', { projectId: 'r1', agent: 'codex' }, rpc)
    expect(outcome).toMatchObject({ ok: false, code: 'action_failed' })
    expect(outcome.ok === false && outcome.error).toMatch(
      /the workspace was created: identity:wt2:local:i9$/
    )
  })

  it('names refusals: folder project, two hosts, setup needing a decision', async () => {
    const setupRequired = refusedBy(
      new WorktreeCreateSetupChoiceRefusedError('Setup decision required for this repository')
    )
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
    // The same words from another failure are not a setup refusal.
    const lookalike = new PluginRuntimeRpcError(
      'runtime_error',
      'Setup decision required for this repository'
    )
    expect(
      await call('workspace.create', { projectId: 'r1' }, runtime({ 'worktree.create': lookalike }))
    ).toMatchObject({ ok: false, error: 'Orca could not complete this action' })
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
  const ensured = (disposition: string, handle = 'term_r') =>
    runtime({ 'terminal.ensureAgentSession': { terminal: { handle }, disposition } })
  const row = (worktreeId: string, connectionId: string | null): PluginAgentStatusRow => ({
    paneKey: 't:l',
    worktreeId,
    connectionId,
    state: 'done',
    stateStartedAt: 1,
    agentType: 'claude',
    providerSession: { id: 's-1', transcriptPath: `/t/${worktreeId}-${connectionId}.jsonl` }
  })

  it("resumes by the key each agent takes, with the workspace's own live transcript", async () => {
    const claude = ensured('created')
    // Same session id in another workspace, and on another host, belongs to other agents.
    const statuses = [row('r1::/other', null), row(OTTER.id, 'box'), row(OTTER.id, null)]
    expect(await resume('claude', claude, statuses)).toEqual({
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
        transcriptPath: `/t/${OTTER.id}-null.jsonl`
      },
      presentation: 'background'
    })
    expect(isPluginOpenedTerminal('samples.demo', 'term_r')).toBe(true)
    const cursor = ensured('created')
    await resume('cursor', cursor)
    expect(paramsOf(cursor, 'terminal.ensureAgentSession')).toMatchObject({
      providerSession: { key: 'conversation_id', id: 's-1' }
    })
  })

  it('reports a session a terminal already runs, and refuses transcript-only agents', async () => {
    expect(await resume('codex', ensured('adopted', 'term_old'))).toMatchObject({
      value: { terminalId: 'term_old', started: false }
    })
    const rpc = ensured('created')
    expect(await resume('pi', rpc)).toMatchObject({ ok: false, code: 'invalid_params' })
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('agents.list sessionId', () => {
  it('names the session agent.resume takes, and none it would refuse', async () => {
    const status = (paneKey: string, id: string): PluginAgentStatusRow => ({
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
        listAgentStatuses: () => [status('t:a', 's-1'), status('t:b', '--resume-all')]
      })
    })
    expect(outcome.ok && outcome.value).toMatchObject({
      agents: [{ sessionId: 's-1' }, { sessionId: null }]
    })
  })
})
