import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  PLUGIN_COMMAND_RESULT_MAX_BYTES,
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
    subscribeEvents: vi.fn().mockReturnValue([]),
    invokePluginCommand: vi.fn().mockResolvedValue(null)
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

describe('commands.invoke', () => {
  const invoke = (
    services: PluginHostServices,
    params: unknown,
    overrides: { viaPanel?: boolean; grantedCapabilities?: [] | null } = {}
  ): ReturnType<typeof executePluginHostCall> =>
    executePluginHostCall({
      pluginId: 'orca-samples.demo',
      method: 'commands.invoke',
      params,
      viaPanel: overrides.viaPanel ?? true,
      grantedCapabilities:
        overrides.grantedCapabilities === undefined ? [] : overrides.grantedCapabilities,
      services
    })

  it('invokes the calling plugin own command and returns its value without an audit writer', async () => {
    const services = createServices(vi.fn())
    services.invokePluginCommand = vi.fn().mockResolvedValue({ pong: true, count: 2 })

    const outcome = await invoke(services, { commandId: 'hello-ping', args: { a: 1 } })

    expect(outcome).toEqual({ ok: true, value: { value: { pong: true, count: 2 } } })
    expect(services.invokePluginCommand).toHaveBeenCalledWith('orca-samples.demo', 'hello-ping', {
      a: 1
    })
  })

  it('maps an undefined command result to null', async () => {
    const services = createServices(vi.fn())
    services.invokePluginCommand = vi.fn().mockResolvedValue(undefined)

    await expect(invoke(services, { commandId: 'hello-ping' })).resolves.toEqual({
      ok: true,
      value: { value: null }
    })
  })

  it('takes plugin identity from the call context, never from params', async () => {
    const services = createServices(vi.fn())

    const outcome = await invoke(services, { commandId: 'run', pluginId: 'other.plugin' })

    expect(outcome).toMatchObject({ ok: false, code: 'invalid_params' })
    expect(services.invokePluginCommand).not.toHaveBeenCalled()
  })

  it.each([{}, { commandId: '' }, { commandId: 'Not Valid!' }, { commandId: 42 }])(
    'rejects malformed params %j',
    async (params) => {
      const services = createServices(vi.fn())
      await expect(invoke(services, params)).resolves.toMatchObject({
        ok: false,
        code: 'invalid_params'
      })
      expect(services.invokePluginCommand).not.toHaveBeenCalled()
    }
  )

  it('rejects worker callers before any service call', async () => {
    const services = createServices(vi.fn())
    const outcome = await invoke(services, { commandId: 'hello-ping' }, { viaPanel: false })
    expect(outcome).toMatchObject({ ok: false, code: 'worker_forbidden' })
    expect(services.invokePluginCommand).not.toHaveBeenCalled()
  })

  it('requires current consent', async () => {
    const services = createServices(vi.fn())
    const outcome = await invoke(
      services,
      { commandId: 'hello-ping' },
      { grantedCapabilities: null }
    )
    expect(outcome).toMatchObject({ ok: false, code: 'consent_required' })
    expect(services.invokePluginCommand).not.toHaveBeenCalled()
  })

  it.each([
    'plugin orca-samples.demo does not contribute command nope',
    'plugin orca-samples.demo command tasks is a built-in action alias',
    'plugin orca-samples.demo is not enabled',
    'command run timed out after 30000ms'
  ])('surfaces a command failure as action_failed: %s', async (message) => {
    const services = createServices(vi.fn())
    services.invokePluginCommand = vi.fn().mockRejectedValue(new Error(message))

    await expect(invoke(services, { commandId: 'run' })).resolves.toEqual({
      ok: false,
      code: 'action_failed',
      error: message
    })
  })

  it('rejects a result larger than the 64 KB cap with a clear message', async () => {
    const services = createServices(vi.fn())
    services.invokePluginCommand = vi
      .fn()
      .mockResolvedValue('x'.repeat(PLUGIN_COMMAND_RESULT_MAX_BYTES))

    const outcome = await invoke(services, { commandId: 'run' })

    expect(outcome).toMatchObject({ ok: false, code: 'action_failed' })
    expect(outcome.ok === false && outcome.error).toContain('exceeds')
  })

  it('accepts a result exactly at the cap', async () => {
    const services = createServices(vi.fn())
    // JSON string adds two quote bytes.
    services.invokePluginCommand = vi
      .fn()
      .mockResolvedValue('x'.repeat(PLUGIN_COMMAND_RESULT_MAX_BYTES - 2))

    await expect(invoke(services, { commandId: 'run' })).resolves.toMatchObject({ ok: true })
  })

  it('rejects a non-JSON result as a malformed result', async () => {
    const services = createServices(vi.fn())
    services.invokePluginCommand = vi.fn().mockResolvedValue(() => 1)

    await expect(invoke(services, { commandId: 'run' })).resolves.toMatchObject({
      ok: false,
      code: 'action_failed'
    })
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
      subscribeEvents: vi.fn().mockReturnValue([]),
      invokeCommand: vi.fn().mockResolvedValue(null)
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
