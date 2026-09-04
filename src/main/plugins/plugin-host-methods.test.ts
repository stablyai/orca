import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PLUGIN_WORKSPACE_TERMINAL_LIMIT } from '../../shared/plugins/plugin-host-api'
import { bindPluginHostServices, type PluginRuntimeDelegate } from './plugin-host-service-bindings'
import { executePluginHostCall, type PluginHostServices } from './plugin-host-methods'
import { AgentSessionPtyWriteRefusedError } from '../../shared/agent-session-pty-write-admission'

function createServices(storageSet: PluginHostServices['storage']['set']): PluginHostServices {
  return {
    executeAuthorizedPluginHostCall: vi
      .fn()
      .mockRejectedValue(new Error('scoped file access unavailable')),
    listPluginWorkspaces: vi.fn().mockRejectedValue(new Error('workspace listing unavailable')),
    resolveActiveWorktreeContext: vi.fn().mockResolvedValue(null),
    listWorktreeTerminals: vi.fn().mockResolvedValue([]),
    sendTerminalText: vi.fn().mockResolvedValue({ accepted: true }),
    dispatchPluginNotification: vi.fn().mockResolvedValue({ delivered: true }),
    storage: {
      get: vi.fn(),
      set: storageSet,
      delete: vi.fn(),
      keys: vi.fn().mockReturnValue([])
    },
    secrets: {
      get: vi.fn().mockReturnValue({ ok: true, value: null }),
      set: vi.fn().mockReturnValue({ ok: true }),
      delete: vi.fn()
    },
    settings: {
      getAll: vi.fn().mockReturnValue({}),
      set: vi.fn().mockReturnValue({ ok: true })
    },
    subscribeEvents: vi.fn().mockReturnValue([])
  }
}

describe('executePluginHostCall mutation auditing', () => {
  it('passes the exact scoped grant into the bound handler service', async () => {
    const services = createServices(vi.fn().mockReturnValue({ ok: true }))
    const grant = { kind: 'files:read' as const, paths: ['docs/**'] }
    vi.mocked(services.executeAuthorizedPluginHostCall).mockResolvedValue({
      authorized: true,
      value: { content: 'hello', encoding: 'utf8' }
    })

    await executePluginHostCall({
      pluginId: 'orca-samples.demo',
      method: 'files.read',
      params: { workspaceRef: 'id:folder-1', relativePath: 'docs/readme.md' },
      viaPanel: false,
      grantedCapabilities: [grant],
      services
    })

    expect(services.executeAuthorizedPluginHostCall).toHaveBeenCalledWith(
      'files.read',
      {
        workspaceRef: { type: 'folder', id: 'folder-1' },
        relativePath: 'docs/readme.md'
      },
      grant
    )
  })

  it('executes scoped methods atomically after parsing', async () => {
    const services = createServices(vi.fn().mockReturnValue({ ok: true }))
    vi.mocked(services.executeAuthorizedPluginHostCall).mockResolvedValue({
      authorized: true,
      value: { entries: [] }
    })

    const malformed = await executePluginHostCall({
      pluginId: 'orca-samples.demo',
      method: 'files.readDir',
      params: {},
      viaPanel: false,
      grantedCapabilities: [{ kind: 'files:read', paths: ['src/**'] }],
      services
    })
    expect(malformed).toMatchObject({ code: 'invalid_params' })
    expect(services.executeAuthorizedPluginHostCall).not.toHaveBeenCalled()

    await executePluginHostCall({
      pluginId: 'orca-samples.demo',
      method: 'files.readDir',
      params: { workspaceRef: 'id:folder-1', relativePath: 'src' },
      viaPanel: false,
      grantedCapabilities: [{ kind: 'files:read', paths: ['src/**'] }],
      services
    })

    expect(services.executeAuthorizedPluginHostCall).toHaveBeenCalledOnce()
  })

  it('denies scoped calls before handler work when authorization is unavailable', async () => {
    const services = createServices(vi.fn().mockReturnValue({ ok: true }))
    vi.mocked(services.executeAuthorizedPluginHostCall).mockResolvedValue({ authorized: false })

    const outcome = await executePluginHostCall({
      pluginId: 'orca-samples.demo',
      method: 'files.stat',
      params: { workspaceRef: 'identity:worktree-1', relativePath: 'src/index.ts' },
      viaPanel: false,
      grantedCapabilities: [{ kind: 'files:read', paths: ['src/**'] }],
      services
    })

    expect(outcome).toEqual({
      ok: false,
      code: 'resource_denied',
      error: 'requested resource is unavailable'
    })
    expect(services.executeAuthorizedPluginHostCall).toHaveBeenCalledOnce()
  })

  it('rejects prototype-sensitive storage keys before any host service call', async () => {
    const storageSet = vi.fn().mockReturnValue({ ok: true })
    const outcome = await executePluginHostCall({
      pluginId: 'orca-samples.demo',
      method: 'storage.set',
      params: { key: '__proto__', value: 42 },
      viaPanel: false,
      grantedCapabilities: [{ kind: 'storage' }],
      services: createServices(storageSet),
      audit: { record: vi.fn().mockResolvedValue(undefined) }
    })

    expect(outcome).toMatchObject({ ok: false, code: 'invalid_params' })
    expect(storageSet).not.toHaveBeenCalled()
  })

  it('rejects non-JSON storage values before any host service call', async () => {
    const storageSet = vi.fn().mockReturnValue({ ok: true })
    const outcome = await executePluginHostCall({
      pluginId: 'orca-samples.demo',
      method: 'storage.set',
      params: { key: 'created', value: new Date() },
      viaPanel: false,
      grantedCapabilities: [{ kind: 'storage' }],
      services: createServices(storageSet),
      audit: { record: vi.fn().mockResolvedValue(undefined) }
    })

    expect(outcome).toMatchObject({ ok: false, code: 'invalid_params' })
    expect(storageSet).not.toHaveBeenCalled()
  })

  it('fails closed before a mutation when the audit intent cannot be recorded', async () => {
    const storageSet = vi.fn().mockReturnValue({ ok: true })
    const outcome = await executePluginHostCall({
      pluginId: 'orca-samples.demo',
      method: 'storage.set',
      params: { key: 'answer', value: 42 },
      viaPanel: false,
      grantedCapabilities: [{ kind: 'storage' }],
      services: createServices(storageSet),
      audit: { record: vi.fn().mockRejectedValue(new Error('disk full')) }
    })

    expect(outcome).toMatchObject({ ok: false, code: 'action_failed' })
    expect(storageSet).not.toHaveBeenCalled()
  })

  it('records an intent before the mutation and its outcome afterward', async () => {
    const order: string[] = []
    const storageSet = vi.fn(() => {
      order.push('mutation')
      return { ok: true as const }
    })
    const record = vi.fn(async (entry: { outcome: string }) => {
      order.push(`audit:${entry.outcome}`)
    })

    const outcome = await executePluginHostCall({
      pluginId: 'orca-samples.demo',
      method: 'storage.set',
      params: { key: 'answer', value: 42 },
      viaPanel: false,
      grantedCapabilities: [{ kind: 'storage' }],
      services: createServices(storageSet),
      audit: { record }
    })

    expect(outcome).toEqual({ ok: true, value: { ok: true } })
    expect(order).toEqual(['audit:attempt', 'mutation', 'audit:ok'])
  })

  it('refuses mutations when no audit writer is configured', async () => {
    const storageSet = vi.fn().mockReturnValue({ ok: true })
    const outcome = await executePluginHostCall({
      pluginId: 'orca-samples.demo',
      method: 'storage.set',
      params: { key: 'answer', value: 42 },
      viaPanel: false,
      grantedCapabilities: [{ kind: 'storage' }],
      services: createServices(storageSet)
    })

    expect(outcome).toMatchObject({ ok: false, code: 'unavailable' })
    expect(storageSet).not.toHaveBeenCalled()
  })
})

function createTerminalHarness(terminalHandles: string[]): {
  delegate: PluginRuntimeDelegate
  services: PluginHostServices
} {
  const delegate: PluginRuntimeDelegate = {
    listPluginWorkspaces: vi.fn().mockResolvedValue({ workspaces: [] }),
    resolveActiveWorktreeContext: vi.fn().mockResolvedValue({
      worktreeId: 'worktree-1',
      path: '/Users/private/repo',
      branch: 'main',
      displayName: 'Repo'
    }),
    listTerminals: vi.fn().mockResolvedValue({
      terminals: terminalHandles.map((handle) => ({ handle, title: null }))
    }),
    sendTerminal: vi.fn().mockResolvedValue({ accepted: true }),
    dispatchPluginNotification: vi.fn().mockResolvedValue({ delivered: true }),
    executePluginFileMethod: vi.fn()
  }
  return {
    delegate,
    services: bindPluginHostServices({
      delegate,
      pluginsDataDir: join(tmpdir(), 'plugin-host-methods-test'),
      subscribeEvents: vi.fn().mockReturnValue([])
    })
  }
}

async function sendTerminalText(
  services: PluginHostServices,
  terminalId: string
): ReturnType<typeof executePluginHostCall> {
  return executePluginHostCall({
    pluginId: 'orca-samples.demo',
    method: 'terminal.sendText',
    params: { terminalId, text: 'echo hi', enter: true },
    viaPanel: true,
    grantedCapabilities: [{ kind: 'terminal:send' }],
    services,
    audit: { record: vi.fn().mockResolvedValue(undefined) }
  })
}

describe('terminal.sendText explicit worktree routing', () => {
  it('performs one bounded list and zero sends when the terminal is outside the worktree', async () => {
    const { delegate, services } = createTerminalHarness(['terminal:local:other'])

    const outcome = await sendTerminalText(services, 'terminal:ssh:requested')

    expect(outcome).toMatchObject({ ok: false, code: 'action_failed' })
    expect(delegate.resolveActiveWorktreeContext).toHaveBeenCalledTimes(1)
    expect(delegate.listTerminals).toHaveBeenCalledTimes(1)
    expect(delegate.listTerminals).toHaveBeenCalledWith(
      'id:worktree-1',
      PLUGIN_WORKSPACE_TERMINAL_LIMIT,
      { includeVisualLayouts: false }
    )
    expect(delegate.sendTerminal).not.toHaveBeenCalled()
  })

  it.each(['terminal:local:one', 'terminal:ssh:opaque-provider-id'])(
    'performs one bounded list and one send for provider-agnostic id %s',
    async (terminalId) => {
      const { delegate, services } = createTerminalHarness([terminalId])

      const outcome = await sendTerminalText(services, terminalId)

      expect(outcome).toEqual({ ok: true, value: { accepted: true } })
      expect(delegate.resolveActiveWorktreeContext).toHaveBeenCalledTimes(1)
      expect(delegate.listTerminals).toHaveBeenCalledTimes(1)
      expect(delegate.listTerminals).toHaveBeenCalledWith(
        'id:worktree-1',
        PLUGIN_WORKSPACE_TERMINAL_LIMIT,
        { includeVisualLayouts: false }
      )
      expect(delegate.sendTerminal).toHaveBeenCalledTimes(1)
      expect(delegate.sendTerminal).toHaveBeenCalledWith(terminalId, {
        text: 'echo hi',
        enter: true
      })
      expect(vi.mocked(delegate.listTerminals).mock.invocationCallOrder[0]!).toBeLessThan(
        vi.mocked(delegate.sendTerminal).mock.invocationCallOrder[0]!
      )
    }
  )

  it('bounds workspace.readContext and omits the provider path', async () => {
    const handles = Array.from(
      { length: PLUGIN_WORKSPACE_TERMINAL_LIMIT + 10 },
      (_, index) => `terminal:local:${index}`
    )
    const { delegate, services } = createTerminalHarness(handles)

    const outcome = await executePluginHostCall({
      pluginId: 'orca-samples.demo',
      method: 'workspace.readContext',
      params: {},
      viaPanel: true,
      grantedCapabilities: [{ kind: 'workspace:read' }],
      services
    })

    expect(outcome).toMatchObject({
      ok: true,
      value: { branch: 'main', displayName: 'Repo' }
    })
    expect(outcome).not.toHaveProperty('value.path')
    expect(outcome).not.toHaveProperty('value.worktreeId')
    expect(outcome.ok && (outcome.value as { terminals: unknown[] }).terminals).toHaveLength(
      PLUGIN_WORKSPACE_TERMINAL_LIMIT
    )
    expect(delegate.listTerminals).toHaveBeenCalledTimes(1)
  })
})

describe('terminal.sendText under a refusing agent-session lease', () => {
  it('sanitizes lease refusal details instead of returning provider state', async () => {
    const { delegate, services } = createTerminalHarness(['terminal:local:one'])
    vi.mocked(delegate.sendTerminal).mockRejectedValue(
      new AgentSessionPtyWriteRefusedError({
        code: 'agent_session_conflict',
        sessionId: 'session-alpha-1',
        ownerRuntimeKind: 'native',
        handoffStage: null,
        ownerPid: 4242,
        runtimeFence: 7
      })
    )

    const outcome = await sendTerminalText(services, 'terminal:local:one')

    expect(outcome).toEqual({ ok: false, code: 'action_failed', error: 'host action failed' })
  })

  it('sends unchanged when no lease refuses, which is every plugin send today', async () => {
    const { delegate, services } = createTerminalHarness(['terminal:local:one'])

    const outcome = await sendTerminalText(services, 'terminal:local:one')

    expect(outcome).toEqual({ ok: true, value: { accepted: true } })
    expect(delegate.sendTerminal).toHaveBeenCalledTimes(1)
  })
})
