import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PLUGIN_WORKSPACE_TERMINAL_LIMIT } from '../../shared/plugins/plugin-host-api'
import { bindPluginHostServices, type PluginRuntimeDelegate } from './plugin-host-service-bindings'
import { executePluginHostCall, type PluginHostServices } from './plugin-host-methods'
import { AgentSessionPtyWriteRefusedError } from '../../shared/agent-session-pty-write-admission'

function createServices(
  storageSet: PluginHostServices['storage']['set'] = vi.fn().mockReturnValue({ ok: true })
): PluginHostServices {
  return {
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
    subscribeEvents: vi.fn().mockReturnValue([]),
    azureDevOpsBoardsRequest: vi.fn().mockResolvedValue({ status: 200, body: null, code: null }),
    azureDevOpsBoardsOrganizations: vi.fn().mockReturnValue([])
  }
}

describe('executePluginHostCall mutation auditing', () => {
  it('rejects prototype-sensitive storage keys before any host service call', async () => {
    const storageSet = vi.fn().mockReturnValue({ ok: true })
    const outcome = await executePluginHostCall({
      pluginId: 'orca-samples.demo',
      method: 'storage.set',
      params: { key: '__proto__', value: 42 },
      viaPanel: false,
      grantedCapabilities: ['storage'],
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
      grantedCapabilities: ['storage'],
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
      grantedCapabilities: ['storage'],
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
      grantedCapabilities: ['storage'],
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
      grantedCapabilities: ['storage'],
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
    dispatchPluginNotification: vi.fn().mockResolvedValue({ delivered: true })
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
    grantedCapabilities: ['terminal:send'],
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
      grantedCapabilities: ['workspace:read'],
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
  it('reports who holds the session instead of an accepted-looking result', async () => {
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

    expect(outcome).toMatchObject({ ok: false, code: 'action_failed' })
    expect(outcome.ok ? '' : outcome.error).toContain('session-alpha-1')
    expect(outcome.ok ? '' : outcome.error).toContain('native chat')
  })

  it('sends unchanged when no lease refuses, which is every plugin send today', async () => {
    const { delegate, services } = createTerminalHarness(['terminal:local:one'])

    const outcome = await sendTerminalText(services, 'terminal:local:one')

    expect(outcome).toEqual({ ok: true, value: { accepted: true } })
    expect(delegate.sendTerminal).toHaveBeenCalledTimes(1)
  })
})

describe('azureDevOps.boardsRequest', () => {
  it('is denied without the capability', async () => {
    const outcome = await executePluginHostCall({
      pluginId: 'acme.boards',
      method: 'azureDevOps.boardsRequest',
      params: { method: 'GET', path: '/_apis/projects' },
      viaPanel: false,
      grantedCapabilities: ['storage'],
      services: createServices()
    })

    expect(outcome).toMatchObject({ ok: false, code: 'capability_denied' })
  })

  it('is not reachable from a sandboxed panel', async () => {
    const outcome = await executePluginHostCall({
      pluginId: 'acme.boards',
      method: 'azureDevOps.boardsRequest',
      params: { method: 'GET', path: '/_apis/projects' },
      viaPanel: true,
      grantedCapabilities: ['azure-devops:boards'],
      services: createServices()
    })

    expect(outcome).toMatchObject({ ok: false, code: 'panel_forbidden' })
  })

  it('delegates to the proxy when granted', async () => {
    const services = createServices()
    services.azureDevOpsBoardsRequest = vi
      .fn()
      .mockResolvedValue({ status: 200, body: { count: 1 }, code: null })

    const outcome = await executePluginHostCall({
      pluginId: 'acme.boards',
      method: 'azureDevOps.boardsRequest',
      params: { method: 'GET', path: '/_apis/projects' },
      viaPanel: false,
      grantedCapabilities: ['azure-devops:boards'],
      services,
      // azureDevOps.boardsRequest is a mutation (writes are in scope), so the
      // gate requires an audit sink before it will invoke the handler.
      audit: { record: vi.fn().mockResolvedValue(undefined) }
    })

    expect(outcome).toMatchObject({
      ok: true,
      value: { status: 200, body: { count: 1 }, code: null }
    })
  })

  it('passes the selected organization through to the proxy', async () => {
    const services = createServices()
    const boardsRequest = vi.fn().mockResolvedValue({ status: 200, body: { count: 1 }, code: null })
    services.azureDevOpsBoardsRequest = boardsRequest

    const outcome = await executePluginHostCall({
      pluginId: 'acme.boards',
      method: 'azureDevOps.boardsRequest',
      params: { method: 'GET', path: '/_apis/projects', organization: 'FabrikamOps' },
      viaPanel: false,
      grantedCapabilities: ['azure-devops:boards'],
      services,
      audit: { record: vi.fn().mockResolvedValue(undefined) }
    })

    expect(outcome).toMatchObject({ ok: true })
    expect(boardsRequest).toHaveBeenCalledWith(
      expect.objectContaining({ organization: 'FabrikamOps' })
    )
  })

  it('records the HTTP method and path in the audit summary, not a content-free entry', async () => {
    const services = createServices()
    services.azureDevOpsBoardsRequest = vi
      .fn()
      .mockResolvedValue({ status: 200, body: { count: 1 }, code: null })
    const record = vi.fn().mockResolvedValue(undefined)

    await executePluginHostCall({
      pluginId: 'acme.boards',
      method: 'azureDevOps.boardsRequest',
      params: { method: 'PATCH', path: '/_apis/wit/workitems/42' },
      viaPanel: false,
      grantedCapabilities: ['azure-devops:boards'],
      services,
      audit: { record }
    })

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ summary: 'PATCH /_apis/wit/workitems/42' })
    )
  })

  it('names the organization a write reached in the audit summary', async () => {
    const services = createServices()
    services.azureDevOpsBoardsRequest = vi
      .fn()
      .mockResolvedValue({ status: 200, body: { count: 1 }, code: null })
    const record = vi.fn().mockResolvedValue(undefined)

    await executePluginHostCall({
      pluginId: 'acme.boards',
      method: 'azureDevOps.boardsRequest',
      params: {
        method: 'PATCH',
        path: '/_apis/wit/workitems/42',
        organization: 'FabrikamOps'
      },
      viaPanel: false,
      grantedCapabilities: ['azure-devops:boards'],
      services,
      audit: { record }
    })

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ summary: 'PATCH /_apis/wit/workitems/42 org=FabrikamOps' })
    )
  })
})

describe('azureDevOps.boardsOrganizations discovery', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns exactly the configured organization names, with no credential material', async () => {
    vi.stubEnv(
      'ORCA_AZURE_DEVOPS_API_BASE_URL',
      'https://dev.azure.com/contoso-labs, https://dev.azure.com/FabrikamOps'
    )
    vi.stubEnv('ORCA_AZURE_DEVOPS_TOKEN', 'super-secret-pat')
    vi.stubEnv('ORCA_AZURE_DEVOPS_USERNAME', 'someone@example.com')

    const outcome = await executePluginHostCall({
      pluginId: 'acme.boards',
      method: 'azureDevOps.boardsOrganizations',
      params: {},
      viaPanel: false,
      grantedCapabilities: ['azure-devops:boards'],
      services: createTerminalHarness([]).services
    })

    expect(outcome).toEqual({
      ok: true,
      value: { organizations: ['contoso-labs', 'FabrikamOps'] }
    })
    const serialized = JSON.stringify(outcome)
    expect(serialized).not.toContain('super-secret-pat')
    expect(serialized).not.toContain('someone@example.com')
    expect(serialized).not.toContain('dev.azure.com')
  })

  it('needs the boards capability like the proxy itself', async () => {
    const outcome = await executePluginHostCall({
      pluginId: 'acme.boards',
      method: 'azureDevOps.boardsOrganizations',
      params: {},
      viaPanel: false,
      grantedCapabilities: ['storage'],
      services: createServices()
    })

    expect(outcome).toMatchObject({ ok: false, code: 'capability_denied' })
  })

  it('is not reachable from a sandboxed panel', async () => {
    const outcome = await executePluginHostCall({
      pluginId: 'acme.boards',
      method: 'azureDevOps.boardsOrganizations',
      params: {},
      viaPanel: true,
      grantedCapabilities: ['azure-devops:boards'],
      services: createServices()
    })

    expect(outcome).toMatchObject({ ok: false, code: 'panel_forbidden' })
  })
})
