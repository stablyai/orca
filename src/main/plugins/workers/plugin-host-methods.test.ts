import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { PluginCapabilityKind } from '../../../shared/plugins/capabilities/plugin-capabilities'
import { PLUGIN_WORKSPACE_TERMINAL_LIMIT } from '../../../shared/plugins/workers/plugin-host-api'
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
    invokePluginCommand: vi.fn().mockResolvedValue(null),
    secrets: {
      get: vi.fn().mockReturnValue({ ok: true, value: null }),
      set: vi.fn().mockReturnValue({ ok: true }),
      delete: vi.fn()
    },
    settings: {
      getAll: vi.fn().mockReturnValue({}),
      set: vi.fn().mockReturnValue({ ok: true })
    }
  }
}

describe('executePluginHostCall mutation auditing', () => {
  it('rejects prototype-sensitive storage keys before any host service call', async () => {
    const storageSet = vi.fn().mockReturnValue({ ok: true })
    const outcome = await executePluginHostCall({
      pluginId: 'samples.demo',
      method: 'storage.set',
      params: { key: '__proto__', value: 42 },
      surface: 'worker',
      grantedCapabilities: ['storage:own'],
      services: createServices(storageSet),
      audit: { record: vi.fn().mockResolvedValue(undefined) }
    })

    expect(outcome).toMatchObject({ ok: false, code: 'invalid_params' })
    expect(storageSet).not.toHaveBeenCalled()
  })

  it('rejects non-JSON storage values before any host service call', async () => {
    const storageSet = vi.fn().mockReturnValue({ ok: true })
    const outcome = await executePluginHostCall({
      pluginId: 'samples.demo',
      method: 'storage.set',
      params: { key: 'created', value: new Date() },
      surface: 'worker',
      grantedCapabilities: ['storage:own'],
      services: createServices(storageSet),
      audit: { record: vi.fn().mockResolvedValue(undefined) }
    })

    expect(outcome).toMatchObject({ ok: false, code: 'invalid_params' })
    expect(storageSet).not.toHaveBeenCalled()
  })

  it('fails closed before a mutation when the audit intent cannot be recorded', async () => {
    const storageSet = vi.fn().mockReturnValue({ ok: true })
    const outcome = await executePluginHostCall({
      pluginId: 'samples.demo',
      method: 'storage.set',
      params: { key: 'answer', value: 42 },
      surface: 'worker',
      grantedCapabilities: ['storage:own'],
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
      pluginId: 'samples.demo',
      method: 'storage.set',
      params: { key: 'answer', value: 42 },
      surface: 'worker',
      grantedCapabilities: ['storage:own'],
      services: createServices(storageSet),
      audit: { record }
    })

    expect(outcome).toEqual({ ok: true, value: { ok: true } })
    expect(order).toEqual(['audit:attempt', 'mutation', 'audit:ok'])
  })

  it('refuses mutations when no audit writer is configured', async () => {
    const storageSet = vi.fn().mockReturnValue({ ok: true })
    const outcome = await executePluginHostCall({
      pluginId: 'samples.demo',
      method: 'storage.set',
      params: { key: 'answer', value: 42 },
      surface: 'worker',
      grantedCapabilities: ['storage:own'],
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
      invokeCommand: vi.fn().mockResolvedValue(null)
    })
  }
}

async function sendTerminalText(
  services: PluginHostServices,
  terminalId: string
): ReturnType<typeof executePluginHostCall> {
  return executePluginHostCall({
    pluginId: 'samples.demo',
    method: 'terminal.sendText',
    params: { terminalId, text: 'echo hi', enter: true },
    surface: 'worker',
    grantedCapabilities: ['terminal:send'],
    services,
    audit: { record: vi.fn().mockResolvedValue(undefined) }
  })
}

describe('terminal.sendText panel surface', () => {
  it('refuses a sandboxed panel even with terminal:send granted', async () => {
    const { delegate, services } = createTerminalHarness(['term-1'])
    const outcome = await executePluginHostCall({
      pluginId: 'orca-samples.demo',
      method: 'terminal.sendText',
      params: { terminalId: 'term-1', text: 'echo hi', enter: true },
      surface: 'panel',
      grantedCapabilities: ['terminal:send'],
      services,
      audit: { record: vi.fn().mockResolvedValue(undefined) }
    })
    expect(outcome).toMatchObject({ ok: false, code: 'not_permitted' })
    expect(delegate.sendTerminal).not.toHaveBeenCalled()
  })
})

describe('host API surfaces and strict params', () => {
  const call = (method: string, params: unknown, surface: 'worker' | 'panel' | 'editor') =>
    executePluginHostCall({
      pluginId: 'samples.demo',
      method,
      params,
      surface,
      grantedCapabilities: ['storage:own', 'notifications:show'],
      services: createServices(vi.fn().mockReturnValue({ ok: true })),
      audit: { record: vi.fn().mockResolvedValue(undefined) }
    })

  it('lets each surface call only the methods that list it', async () => {
    await expect(call('storage.keys', {}, 'editor')).resolves.toMatchObject({
      ok: false,
      code: 'not_permitted'
    })
    await expect(call('storage.keys', {}, 'worker')).resolves.toEqual({
      ok: true,
      value: { keys: [] }
    })
    await expect(call('notifications.show', { title: 'Hi' }, 'editor')).resolves.toEqual({
      ok: true,
      value: { delivered: true }
    })
  })

  it('refuses a param this host does not know instead of dropping it', async () => {
    const outcome = await call('notifications.show', { title: 'Hi', silent: true }, 'worker')
    expect(outcome).toMatchObject({ ok: false, code: 'invalid_params' })
    expect(!outcome.ok && outcome.error).toContain('silent')
  })
})

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
      pluginId: 'samples.demo',
      method: 'workspace.readContext',
      params: {},
      surface: 'panel',
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

describe('terminal.sendText', () => {
  it('returns the runtime send acceptance', async () => {
    const { delegate, services } = createTerminalHarness(['terminal:local:one'])

    const outcome = await sendTerminalText(services, 'terminal:local:one')

    expect(outcome).toEqual({ ok: true, value: { accepted: true } })
    expect(delegate.sendTerminal).toHaveBeenCalledTimes(1)
  })
})

describe('commands.execute', () => {
  const panelCall = (
    services: PluginHostServices,
    params: unknown,
    grantedCapabilities: PluginCapabilityKind[] = ['commands:execute'],
    record = vi.fn().mockResolvedValue(undefined)
  ) =>
    executePluginHostCall({
      pluginId: 'samples.demo',
      method: 'commands.execute',
      params,
      surface: 'panel',
      grantedCapabilities,
      services,
      audit: { record }
    })

  it('runs the calling plugin command and returns its JSON value', async () => {
    const invokePluginCommand = vi.fn().mockResolvedValue({ ok: true, message: 'done' })
    const services = { ...createServices(vi.fn()), invokePluginCommand }

    const outcome = await panelCall(services, { commandId: 'swap', params: { account: 'work' } })

    expect(outcome).toEqual({ ok: true, value: { value: { ok: true, message: 'done' } } })
    expect(invokePluginCommand).toHaveBeenCalledWith('samples.demo', 'swap', { account: 'work' })
  })

  it('refuses a panel without the commands:execute capability', async () => {
    const invokePluginCommand = vi.fn()
    const services = { ...createServices(vi.fn()), invokePluginCommand }

    const outcome = await panelCall(services, { commandId: 'swap' }, [])

    expect(outcome).toMatchObject({ ok: false, code: 'capability_denied' })
    expect(invokePluginCommand).not.toHaveBeenCalled()
  })

  it('refuses params over 16 KiB before running any command', async () => {
    const invokePluginCommand = vi.fn()
    const services = { ...createServices(vi.fn()), invokePluginCommand }

    const outcome = await panelCall(services, {
      commandId: 'swap',
      params: { text: 'x'.repeat(16 * 1024) }
    })

    expect(outcome).toMatchObject({ ok: false, code: 'invalid_params' })
    expect(invokePluginCommand).not.toHaveBeenCalled()
  })

  it('maps an undefined command result to null', async () => {
    const services = {
      ...createServices(vi.fn()),
      invokePluginCommand: vi.fn().mockResolvedValue(undefined)
    }

    await expect(panelCall(services, { commandId: 'refresh' })).resolves.toEqual({
      ok: true,
      value: { value: null }
    })
  })

  it('turns a non-JSON command result into an action error', async () => {
    const services = {
      ...createServices(vi.fn()),
      invokePluginCommand: vi.fn().mockResolvedValue(() => 1)
    }

    await expect(panelCall(services, { commandId: 'swap' })).resolves.toMatchObject({
      ok: false,
      code: 'action_failed'
    })
  })

  it('audits the command id and params size, never the params', async () => {
    const record = vi.fn().mockResolvedValue(undefined)
    const services = {
      ...createServices(vi.fn()),
      invokePluginCommand: vi.fn().mockResolvedValue(null)
    }
    const params = { account: 'work' }

    await panelCall(services, { commandId: 'swap', params }, ['commands:execute'], record)

    expect(record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        summary: `command=swap bytes=${Buffer.byteLength(JSON.stringify(params), 'utf8')}`
      })
    )
  })
})
