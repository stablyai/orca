import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  getPluginHostMethodSpec,
  PLUGIN_TERMINAL_AGENT_MAX_LENGTH,
  PLUGIN_TERMINAL_ID_MAX_LENGTH,
  PLUGIN_WORKSPACE_TERMINAL_LIMIT
} from '../../shared/plugins/plugin-host-api'
import { bindPluginHostServices, type PluginRuntimeDelegate } from './plugin-host-service-bindings'
import { executePluginHostCall, type PluginHostServices } from './plugin-host-methods'

function createServices(storageSet: PluginHostServices['storage']['set']): PluginHostServices {
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
    subscribeEvents: vi.fn().mockReturnValue([])
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

type ListedTerminal = Awaited<
  ReturnType<PluginRuntimeDelegate['listTerminals']>
>['terminals'][number]

function createTerminalHarness(
  terminals: (string | ListedTerminal)[],
  activePane: { tabId: string; leafId: string } | null = null
): {
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
      terminals: terminals.map((terminal) =>
        typeof terminal === 'string'
          ? { handle: terminal, tabId: 'tab-1', leafId: terminal, title: 'claude: secret prompt' }
          : terminal
      )
    }),
    getActiveTerminalPane: vi.fn().mockReturnValue(activePane),
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
      expect(delegate.sendTerminal).toHaveBeenCalledWith(
        terminalId,
        {
          text: 'echo hi',
          enter: true
        },
        { inputKind: 'driving' }
      )
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
    expect(outcome).not.toHaveProperty('value.terminals.0.title')
    expect(delegate.listTerminals).toHaveBeenCalledTimes(1)
  })
})

describe('workspace.readContext active terminal', () => {
  const claudePane = { handle: 'terminal:ssh:claude', tabId: 'tab-1', leafId: 'pane:1' }
  const shellPane = { handle: 'terminal:local:shell', tabId: 'tab-1', leafId: 'pane:2' }

  async function readContext(services: PluginHostServices): Promise<unknown> {
    const outcome = await executePluginHostCall({
      pluginId: 'orca-samples.demo',
      method: 'workspace.readContext',
      params: {},
      viaPanel: true,
      grantedCapabilities: ['workspace:read'],
      services
    })
    if (!outcome.ok) {
      throw new Error(`readContext failed: ${outcome.error}`)
    }
    return outcome.value
  }

  it('names the focused pane and each terminal agent', async () => {
    const { delegate, services } = createTerminalHarness(
      [{ ...claudePane, agentIdentity: 'claude' }, shellPane],
      { tabId: 'tab-1', leafId: 'pane:1' }
    )

    await expect(readContext(services)).resolves.toEqual({
      branch: 'main',
      displayName: 'Repo',
      terminals: [
        { id: 'terminal:ssh:claude', agent: 'claude' },
        { id: 'terminal:local:shell', agent: null }
      ],
      activeTerminalId: 'terminal:ssh:claude'
    })
    expect(delegate.getActiveTerminalPane).toHaveBeenCalledWith('worktree-1')
  })

  it('picks the focused leaf among the panes of one split tab', async () => {
    const { services } = createTerminalHarness([claudePane, shellPane], {
      tabId: 'tab-1',
      leafId: 'pane:2'
    })

    await expect(readContext(services)).resolves.toMatchObject({
      activeTerminalId: 'terminal:local:shell'
    })
  })

  it('returns null when the active tab is not a terminal', async () => {
    const { services } = createTerminalHarness([claudePane, shellPane], null)

    await expect(readContext(services)).resolves.toMatchObject({ activeTerminalId: null })
  })

  it('returns null when the focused pane is not in the returned terminals', async () => {
    const oversized = {
      handle: 'x'.repeat(PLUGIN_TERMINAL_ID_MAX_LENGTH + 1),
      tabId: 'tab-2',
      leafId: 'pane:1'
    }
    const { services } = createTerminalHarness([claudePane, oversized], {
      tabId: 'tab-2',
      leafId: 'pane:1'
    })

    await expect(readContext(services)).resolves.toEqual({
      branch: 'main',
      displayName: 'Repo',
      terminals: [{ id: 'terminal:ssh:claude', agent: null }],
      activeTerminalId: null
    })
  })

  it('drops an oversized agent id instead of truncating it', async () => {
    const { services } = createTerminalHarness([
      { ...claudePane, agentIdentity: 'a'.repeat(PLUGIN_TERMINAL_AGENT_MAX_LENGTH + 1) }
    ])

    await expect(readContext(services)).resolves.toMatchObject({
      terminals: [{ id: 'terminal:ssh:claude', agent: null }]
    })
  })

  it('rejects a result whose active terminal is not one of its terminals', () => {
    const result = getPluginHostMethodSpec('workspace.readContext')!.result

    expect(
      result.safeParse({
        branch: 'main',
        displayName: 'Repo',
        terminals: [{ id: 'terminal:local:one', agent: null }],
        activeTerminalId: 'terminal:local:other'
      }).success
    ).toBe(false)
  })
})

describe('terminal.sendText', () => {
  it('returns the runtime send acceptance', async () => {
    const { delegate, services } = createTerminalHarness(['terminal:local:one'])

    const outcome = await sendTerminalText(services, 'terminal:local:one')

    expect(outcome).toEqual({ ok: true, value: { accepted: true } })
    expect(delegate.sendTerminal).toHaveBeenCalledTimes(1)
  })
})
