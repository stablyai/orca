import { describe, expect, it, vi } from 'vitest'
import type { PluginCapabilityKind } from '../../../shared/plugins/capabilities/plugin-capabilities'
import { executePluginHostCall, type PluginHostServices } from './plugin-host-methods'
import { pluginHostCallRevoked, type PluginHostCallScope } from './plugin-host-call-scope'
import type { PluginRuntimeRpc } from './plugin-host-workspace-method-bindings'
import type { PluginHostRendererActions } from '../view/plugin-host-renderer-actions'

function services(
  runtimeRpc: PluginRuntimeRpc | null,
  renderer: PluginHostRendererActions | null = null
): PluginHostServices {
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
    runtimeRpc,
    renderer
  }
}

type RecordedCall = { method: string; params: unknown; signal?: AbortSignal }

/** A runtime answering each CLI method with `answers[method]`; it runs `beforeEffect` as the
 *  dispatcher does, just before it would act. */
function runtime(answers: Record<string, unknown>) {
  const calls: RecordedCall[] = []
  const rpc: PluginRuntimeRpc = async (method, params, options = {}) => {
    options.beforeEffect?.()
    calls.push({ method, params, ...(options.signal ? { signal: options.signal } : {}) })
    if (!(method in answers)) {
      throw new Error(`unexpected ${method}`)
    }
    return answers[method]
  }
  return { rpc, calls }
}

const ALL: PluginCapabilityKind[] = [
  'workspace:read',
  'workspace:write',
  'terminal:send',
  'terminal:read',
  'agent:launch'
]

function call(
  method: string,
  params: unknown,
  rpc: PluginRuntimeRpc | null,
  options: {
    capabilities?: PluginCapabilityKind[]
    surface?: 'worker' | 'panel'
    scope?: PluginHostCallScope
    renderer?: PluginHostRendererActions | null
  } = {}
) {
  return executePluginHostCall({
    pluginId: 'acme.mod',
    method,
    params,
    surface: options.surface ?? 'worker',
    grantedCapabilities: options.capabilities ?? ALL,
    services: services(rpc, options.renderer ?? null),
    audit: { record: vi.fn().mockResolvedValue(undefined) },
    ...(options.scope ? { scope: options.scope } : {})
  })
}

const worktree = (id: string, repoId: string, extra: Record<string, unknown> = {}) => ({
  id,
  repoId,
  displayName: id,
  path: `/work/${id}`,
  ...extra
})

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('workspace host actions', () => {
  it('workspace.list names worktrees and folders, each with an id that names its host', async () => {
    const { rpc, calls } = runtime({
      'worktree.list': {
        worktrees: [
          worktree('r1::/work/app', 'r1', {
            branch: 'refs/heads/main',
            hostId: 'ssh:box',
            identity: { key: 'wt2:ssh%3Abox:i1' }
          }),
          worktree('r2::/work/notes', 'r2', { branch: '' })
        ],
        totalCount: 3,
        truncated: false
      },
      'repo.list': {
        repos: [
          { id: 'r1', kind: 'git' },
          { id: 'r2', kind: 'folder' }
        ]
      },
      'folderWorkspace.list': {
        folderWorkspaces: [
          { id: 'f1', name: 'home', folderPath: '/home/me', executionHostId: null }
        ]
      }
    })
    const outcome = await call('workspace.list', undefined, rpc)
    expect(outcome).toMatchObject({
      ok: true,
      value: {
        workspaces: [
          { id: 'identity:wt2:ssh%3Abox:i1', kind: 'worktree', branch: 'main', hostId: 'ssh:box' },
          { id: 'r2::/work/notes', kind: 'folder', branch: null, hostId: null },
          { id: 'folder:f1', kind: 'folder', name: 'home', path: '/home/me', branch: null }
        ],
        truncated: true
      }
    })
    expect(calls[0]).toMatchObject({ method: 'worktree.list', params: { limit: 500 } })
  })

  it('takes a listed id back as the selector that names its host', async () => {
    const { rpc, calls } = runtime({ 'worktree.activate': {} })
    await call('workspace.open', { workspaceId: 'identity:wt2:ssh%3Abox:i1' }, rpc)
    await call('workspace.open', { workspaceId: 'r1::/work/app' }, rpc)
    expect(calls.map((entry) => entry.params)).toEqual([
      { worktree: 'identity:wt2:ssh%3Abox:i1' },
      { worktree: 'id:r1::/work/app' }
    ])
    await expect(call('workspace.open', { workspaceId: 'folder:f1' }, rpc)).resolves.toMatchObject({
      ok: false,
      code: 'unavailable'
    })
  })

  it('terminal.create opens a terminal in the background and returns its id', async () => {
    const { rpc, calls } = runtime({ 'terminal.create': { terminal: { handle: 'term-1' } } })
    const outcome = await call(
      'terminal.create',
      { workspaceId: 'folder:f1', title: 'tests', command: 'pnpm test' },
      rpc
    )
    expect(outcome).toEqual({ ok: true, value: { terminalId: 'term-1' } })
    expect(calls[0]?.params).toEqual({
      worktree: 'id:folder:f1',
      title: 'tests',
      command: 'pnpm test',
      presentation: 'background'
    })
  })

  it('terminal.read returns the newest lines and counts a runtime-limited read as truncated', async () => {
    const tail = Array.from({ length: 5 }, (_, index) => `line ${index}`)
    const { rpc, calls } = runtime({ 'terminal.read': { terminal: { tail, truncated: false } } })
    await expect(call('terminal.read', { terminalId: 't', maxLines: 2 }, rpc)).resolves.toEqual({
      ok: true,
      value: { lines: ['line 3', 'line 4'], truncated: true }
    })
    expect(calls[0]?.params).toEqual({ terminal: 't', limit: 2 })
    const limited = runtime({
      'terminal.read': { terminal: { tail: ['a'], truncated: false, limited: true } }
    })
    await expect(call('terminal.read', { terminalId: 't' }, limited.rpc)).resolves.toEqual({
      ok: true,
      value: { lines: ['a'], truncated: true }
    })
    await expect(
      call('terminal.read', { terminalId: 't', maxLines: 2001 }, rpc)
    ).resolves.toMatchObject({ ok: false, code: 'invalid_params' })
  })

  it('agent.launch returns once the agent starts and sends the prompt after', async () => {
    let deliver: (value: unknown) => void = () => {}
    const calls: RecordedCall[] = []
    const rpc: PluginRuntimeRpc = async (method, params) => {
      calls.push({ method, params })
      return calls.length === 1
        ? { outcome: { kind: 'terminal', handle: 'term-9' } }
        : new Promise((resolve) => (deliver = resolve))
    }
    const outcome = await call(
      'agent.launch',
      { workspaceId: 'r1::/work/app', agent: 'claude', prompt: 'fix the build' },
      rpc
    )
    expect(outcome).toEqual({ ok: true, value: { terminalId: 'term-9' } })
    expect(calls[0]?.params).toEqual({
      target: { kind: 'existing', worktree: 'id:r1::/work/app' },
      agent: 'claude',
      surface: 'terminal',
      presentation: 'background',
      launchSource: 'plugin'
    })
    // The prompt rides the runtime's own delivery into that agent, still in flight.
    expect(calls[1]?.params).toMatchObject({
      reuseTerminal: { handle: 'term-9' },
      prompt: { text: 'fix the build', delivery: 'submit' }
    })
    deliver({ outcome: { kind: 'terminal', handle: 'term-9' } })
    await expect(
      call('agent.launch', { workspaceId: 'app', agent: 'not-an-agent' }, rpc)
    ).resolves.toMatchObject({ ok: false, code: 'invalid_params' })
  })

  it('refuses the effect when the plugin loses approval while the runtime prepares it', async () => {
    let revoked = false
    const scope: PluginHostCallScope = {
      assertActive: () => {
        if (revoked) {
          throw pluginHostCallRevoked()
        }
      }
    }
    const effects: string[] = []
    const rpc: PluginRuntimeRpc = async (method, _params, options = {}) => {
      revoked = true // the runtime's own waits (admission, feature readiness) happen here
      options.beforeEffect?.()
      effects.push(method)
      return { terminal: { handle: 'x' } }
    }
    await expect(
      call('terminal.create', { workspaceId: 'app' }, rpc, { scope })
    ).resolves.toMatchObject({ ok: false, code: 'consent_required' })
    expect(effects).toEqual([])
  })

  it("passes the worker's cancellation to the runtime", async () => {
    const cancel = new AbortController()
    const { rpc, calls } = runtime({ 'terminal.create': { terminal: { handle: 't' } } })
    await call('terminal.create', { workspaceId: 'app' }, rpc, {
      scope: { assertActive: () => {}, signal: cancel.signal }
    })
    expect(calls[0]?.signal).toBe(cancel.signal)
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
    await flush()
    await expect(call('workspace.list', undefined, null)).resolves.toMatchObject({ ok: false })
  })

  it('editor.open asks the window to open a file inside the workspace', async () => {
    const renderer = { openFile: vi.fn().mockResolvedValue(undefined), runAction: vi.fn() }
    await expect(
      call('editor.open', { workspaceId: 'app', path: 'src/main.ts' }, null, { renderer })
    ).resolves.toEqual({ ok: true, value: { opened: true } })
    expect(renderer.openFile).toHaveBeenCalledWith('app', 'src/main.ts')
    for (const path of ['../secret', '/etc/passwd', 'C:\\x', 'a/../../b', '.']) {
      await expect(
        call('editor.open', { workspaceId: 'app', path }, null, { renderer })
      ).resolves.toMatchObject({ ok: false, code: 'invalid_params' })
    }
    expect(renderer.openFile).toHaveBeenCalledTimes(1)
  })

  it("commands.run runs only built-in actions, and needs Orca's window", async () => {
    const renderer = { openFile: vi.fn(), runAction: vi.fn().mockResolvedValue(undefined) }
    await expect(
      call('commands.run', { action: 'sidebar.left.toggle' }, null, { renderer })
    ).resolves.toEqual({ ok: true, value: { ran: true } })
    expect(renderer.runAction).toHaveBeenCalledWith('sidebar.left.toggle')
    await expect(
      call('commands.run', { action: 'editor.save' }, null, { renderer })
    ).resolves.toMatchObject({ ok: false, code: 'invalid_params' })
    await expect(
      call('commands.run', { action: 'sidebar.left.toggle' }, null)
    ).resolves.toMatchObject({ ok: false, code: 'unavailable' })
  })
})
