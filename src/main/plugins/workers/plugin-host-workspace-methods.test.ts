import { describe, expect, it, vi } from 'vitest'
import type { PluginCapabilityKind } from '../../../shared/plugins/capabilities/plugin-capabilities'
import { executePluginHostCall, type PluginHostServices } from './plugin-host-methods'
import type { PluginRuntimeRpc } from './plugin-host-workspace-method-bindings'

function services(runtimeRpc: PluginRuntimeRpc | null): PluginHostServices {
  return {
    resolveActiveWorktreeContext: vi.fn().mockResolvedValue(null),
    listWorktreeTerminals: vi.fn().mockResolvedValue([]),
    sendTerminalText: vi.fn().mockResolvedValue({ accepted: true }),
    listAgentStatuses: () => [],
    dispatchPluginNotification: vi.fn().mockResolvedValue({ delivered: true }),
    storage: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), keys: vi.fn().mockReturnValue([]) },
    secrets: {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
      protection: vi.fn().mockReturnValue('unavailable')
    },
    settings: { getAll: vi.fn().mockReturnValue({}), set: vi.fn() },
    runtimeRpc
  }
}

/** A runtime answering each CLI method with `answers[method]`, recording every call. */
function runtime(answers: Record<string, unknown>) {
  const calls: { method: string; params: unknown }[] = []
  const rpc: PluginRuntimeRpc = async (method, params) => {
    calls.push({ method, params })
    if (!(method in answers)) {
      throw new Error(`unexpected ${method}`)
    }
    return answers[method]
  }
  return { rpc, calls }
}

function call(
  method: string,
  params: unknown,
  rpc: PluginRuntimeRpc | null,
  options: { capabilities?: PluginCapabilityKind[]; surface?: 'worker' | 'panel' } = {}
) {
  return executePluginHostCall({
    pluginId: 'acme.mod',
    method,
    params,
    surface: options.surface ?? 'worker',
    grantedCapabilities: options.capabilities ?? [
      'workspace:read',
      'workspace:write',
      'terminal:send',
      'terminal:read',
      'agent:launch'
    ],
    services: services(rpc),
    audit: { record: vi.fn().mockResolvedValue(undefined) }
  })
}

const worktree = (id: string, repoId: string, extra: Record<string, unknown> = {}) => ({
  id,
  repoId,
  displayName: id,
  path: `/work/${id}`,
  ...extra
})

describe('workspace host actions', () => {
  it('workspace.list names worktrees and folders, with branch and execution host', async () => {
    const { rpc, calls } = runtime({
      'worktree.list': {
        worktrees: [
          worktree('app', 'r1', { branch: 'refs/heads/main', hostId: 'ssh:box' }),
          worktree('notes', 'r2', { branch: '' })
        ],
        totalCount: 3,
        truncated: false
      },
      'repo.list': {
        repos: [
          { id: 'r1', kind: 'git' },
          { id: 'r2', kind: 'folder' }
        ]
      }
    })
    const outcome = await call('workspace.list', undefined, rpc)
    expect(outcome).toEqual({
      ok: true,
      value: {
        workspaces: [
          {
            id: 'app',
            kind: 'worktree',
            name: 'app',
            path: '/work/app',
            branch: 'main',
            hostId: 'ssh:box'
          },
          {
            id: 'notes',
            kind: 'folder',
            name: 'notes',
            path: '/work/notes',
            branch: null,
            hostId: null
          }
        ],
        truncated: true
      }
    })
    expect(calls[0]).toEqual({ method: 'worktree.list', params: { limit: 500 } })
  })

  it('workspace.open activates the workspace as the CLI does', async () => {
    const { rpc, calls } = runtime({ 'worktree.activate': {} })
    await expect(call('workspace.open', { workspaceId: 'app' }, rpc)).resolves.toEqual({
      ok: true,
      value: { opened: true }
    })
    expect(calls).toEqual([{ method: 'worktree.activate', params: { worktree: 'id:app' } }])
  })

  it('terminal.create opens a terminal and returns its id', async () => {
    const { rpc, calls } = runtime({ 'terminal.create': { terminal: { handle: 'term-1' } } })
    const outcome = await call(
      'terminal.create',
      { workspaceId: 'app', title: 'tests', command: 'pnpm test' },
      rpc
    )
    expect(outcome).toEqual({ ok: true, value: { terminalId: 'term-1' } })
    expect(calls[0]?.params).toEqual({ worktree: 'id:app', title: 'tests', command: 'pnpm test' })
  })

  it('terminal.read returns the newest lines, bounded', async () => {
    const tail = Array.from({ length: 5 }, (_, index) => `line ${index}`)
    const { rpc, calls } = runtime({ 'terminal.read': { terminal: { tail, truncated: false } } })
    await expect(call('terminal.read', { terminalId: 't', maxLines: 2 }, rpc)).resolves.toEqual({
      ok: true,
      value: { lines: ['line 3', 'line 4'], truncated: true }
    })
    expect(calls[0]?.params).toEqual({ terminal: 't', limit: 2 })
    await expect(
      call('terminal.read', { terminalId: 't', maxLines: 2001 }, rpc)
    ).resolves.toMatchObject({
      ok: false,
      code: 'invalid_params'
    })
  })

  it('agent.launch starts the agent in the background and returns its terminal', async () => {
    const { rpc, calls } = runtime({
      'agent.launch': { outcome: { kind: 'structured', sessionId: 's', handle: 'term-9' } }
    })
    const outcome = await call(
      'agent.launch',
      { workspaceId: 'app', agent: 'claude', prompt: 'fix the build' },
      rpc
    )
    expect(outcome).toEqual({ ok: true, value: { terminalId: 'term-9', surface: 'chat' } })
    expect(calls[0]?.params).toMatchObject({
      target: { kind: 'existing', worktree: 'id:app' },
      agent: 'claude',
      prompt: { text: 'fix the build', delivery: 'submit' },
      presentation: 'background'
    })
    await expect(
      call('agent.launch', { workspaceId: 'app', agent: 'not-an-agent' }, rpc)
    ).resolves.toMatchObject({ ok: false, code: 'invalid_params' })
  })

  it("needs each method's capability and a worker, and a host with a runtime", async () => {
    const { rpc, calls } = runtime({})
    await expect(
      call('terminal.read', { terminalId: 't' }, rpc, { capabilities: ['terminal:send'] })
    ).resolves.toMatchObject({ ok: false, code: 'capability_denied' })
    await expect(
      call('workspace.list', undefined, rpc, { surface: 'panel' })
    ).resolves.toMatchObject({ ok: false, code: 'not_permitted' })
    expect(calls).toEqual([])
    await expect(call('workspace.list', undefined, null)).resolves.toMatchObject({ ok: false })
  })
})
