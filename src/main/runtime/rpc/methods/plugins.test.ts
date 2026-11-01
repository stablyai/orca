import { afterEach, describe, expect, it, vi } from 'vitest'
import { eraseRpcMethods, type RpcContext, type RpcMethod } from '../core'
import type { PluginService } from '../../../plugins/plugin-service'
import { PLUGIN_METHODS, setPluginServiceForRpc } from './plugins'
import { PluginLogBuffer } from '../../../plugins/plugin-log-buffer'
import { PluginGetLogsParams } from '../../../../shared/rpc-contract/plugins-params'

vi.mock('../../../plugins/plugin-client-list', () => ({
  listPluginsForClients: vi.fn().mockResolvedValue([])
}))

function method(name: string): RpcMethod {
  const found = eraseRpcMethods(PLUGIN_METHODS).find((entry) => entry.name === name)
  if (!found) {
    throw new Error(`missing ${name}`)
  }
  if ('stream' in found) {
    throw new Error(`${name} is streaming`)
  }
  return found
}

afterEach(() => setPluginServiceForRpc(null))

describe('plugin approval over RPC', () => {
  const worker = {
    pluginKey: 'acme.worker',
    rootDir: '/plugins/acme.worker',
    consentFingerprint: 'sha256-worker',
    contentHash: `sha256-${'c'.repeat(64)}`,
    isDev: false,
    manifest: {
      id: 'worker',
      publisher: 'acme',
      name: 'Worker',
      version: '2.0.0',
      execution: 'trusted-worker',
      main: 'main.mjs',
      capabilities: [{ kind: 'notifications:show' }],
      contributes: {
        panels: [],
        commands: [],
        events: [],
        languagePacks: [],
        keybindings: [],
        vmRecipes: [],
        themes: [],
        terminalThemes: [],
        iconThemes: [],
        syntaxes: [],
        customEditors: [],
        newFiles: []
      }
    }
  }

  function setup() {
    const applyConsent = vi.fn().mockResolvedValue(undefined)
    const applyEnablement = vi.fn().mockResolvedValue(undefined)
    const recordApprovalAudit = vi.fn().mockResolvedValue(undefined)
    const stub = {
      whenReady: vi.fn().mockResolvedValue(undefined),
      findValidPlugin: (key: string) => (key === worker.pluginKey ? worker : null),
      options: { getPluginConsents: () => ({}), getDisabledPlugins: () => [] },
      recordApprovalAudit,
      getDiscovered: () => []
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the approval handlers only read the members stubbed above.
    setPluginServiceForRpc(stub as unknown as PluginService, { applyConsent, applyEnablement })
    return { applyConsent, applyEnablement, recordApprovalAudit }
  }

  const callerContext = (caller: RpcContext['caller']): RpcContext => ({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: plugin handlers never touch the runtime.
    runtime: {} as RpcContext['runtime'],
    caller
  })
  const cliContext = () => callerContext({ kind: 'local-cli' })

  it('refuses a consent fingerprint read from plugins.list without the approve flag', async () => {
    const { applyConsent } = setup()
    await expect(
      method('plugins.consent').handler(
        { pluginKey: 'acme.worker', reviewedFingerprint: 'sha256-worker', decision: 'approve' },
        cliContext()
      )
    ).rejects.toMatchObject({ code: 'approval_required' })
    expect(applyConsent).not.toHaveBeenCalled()
  })

  it('refuses enabling code over RPC without the approve flag, even for paired devices', async () => {
    const { applyConsent, applyEnablement } = setup()
    await expect(
      method('plugins.setEnabled').handler(
        { pluginKey: 'acme.worker', enabled: true },
        callerContext({ kind: 'paired-device', deviceId: 'd1' })
      )
    ).rejects.toMatchObject({ code: 'approval_required' })
    expect(applyConsent).not.toHaveBeenCalled()
    expect(applyEnablement).not.toHaveBeenCalled()
  })

  it('always allows reducing access', async () => {
    const { applyConsent, applyEnablement } = setup()
    await method('plugins.setEnabled').handler(
      { pluginKey: 'acme.worker', enabled: false },
      cliContext()
    )
    await method('plugins.consent').handler(
      { pluginKey: 'acme.worker', decision: 'keep-disabled' },
      cliContext()
    )
    expect(applyEnablement).toHaveBeenCalledWith('acme.worker', false)
    expect(applyConsent).toHaveBeenCalledWith(
      expect.objectContaining({ pluginKey: 'acme.worker', decision: 'keep-disabled' })
    )
  })
})

describe('plugin system switch over RPC', () => {
  it('is host-admin and turns the system on without approving anything', async () => {
    const applyConsent = vi.fn()
    const setPluginSystemEnabled = vi.fn()
    const refresh = vi.fn().mockResolvedValue(undefined)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the switch handler only waits, refreshes and lists.
    const service = {
      whenReady: vi.fn().mockResolvedValue(undefined),
      refresh
    } as unknown as PluginService
    setPluginServiceForRpc(service, {
      applyConsent,
      applyEnablement: vi.fn(),
      setPluginSystemEnabled
    })
    const switchMethod = method('plugins.setSystemEnabled')

    expect(switchMethod.permission).toBe('host-admin')
    const context: RpcContext = {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: plugin handlers never touch the runtime.
      runtime: {} as RpcContext['runtime'],
      caller: { kind: 'local-cli' }
    }
    await expect(switchMethod.handler({ enabled: true }, context)).resolves.toEqual({
      enabled: true,
      plugins: []
    })
    expect(setPluginSystemEnabled).toHaveBeenCalledWith(true)
    expect(refresh).toHaveBeenCalledAfter(setPluginSystemEnabled)
    expect(applyConsent).not.toHaveBeenCalled()
  })
})

describe('plugins.devInspect', () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: devInspect reads only whenReady.
  const service = { whenReady: vi.fn().mockResolvedValue(undefined) } as unknown as PluginService
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: plugin handlers never touch the runtime.
  const context: RpcContext = {
    runtime: {} as RpcContext['runtime'],
    caller: { kind: 'local-cli' }
  }

  it('opens DevTools through the desktop hook and reports the count', async () => {
    const openFrameDevTools = vi.fn().mockReturnValue(2)
    setPluginServiceForRpc(service, {
      applyConsent: vi.fn(),
      applyEnablement: vi.fn(),
      openFrameDevTools
    })
    await expect(
      method('plugins.devInspect').handler({ pluginKey: 'acme.notes' }, context)
    ).resolves.toEqual({ pluginKey: 'acme.notes', opened: 2 })
    expect(openFrameDevTools).toHaveBeenCalledWith('acme.notes')
  })

  it('fails on a host without guest frames', async () => {
    setPluginServiceForRpc(service, { applyConsent: vi.fn(), applyEnablement: vi.fn() })
    await expect(
      method('plugins.devInspect').handler({ pluginKey: 'acme.notes' }, context)
    ).rejects.toThrow(/desktop app/)
  })
})

describe('plugins.restart', () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: plugin handlers never touch the runtime.
  const context: RpcContext = {
    runtime: {} as RpcContext['runtime'],
    caller: { kind: 'local-cli' }
  }

  function setup(manifest: { main?: string }) {
    const deactivatePlugin = vi.fn().mockResolvedValue(undefined)
    const stub = {
      whenReady: vi.fn().mockResolvedValue(undefined),
      findValidPlugin: (key: string) =>
        key === 'acme.notes' ? { pluginKey: key, manifest } : null,
      deactivatePlugin
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: restart reads only the members stubbed above.
    setPluginServiceForRpc(stub as unknown as PluginService, {
      applyConsent: vi.fn(),
      applyEnablement: vi.fn()
    })
    return deactivatePlugin
  }

  it('stops the worker without touching enablement or approval', async () => {
    const deactivatePlugin = setup({ main: 'main.mjs' })
    await expect(
      method('plugins.restart').handler({ pluginKey: 'acme.notes' }, context)
    ).resolves.toEqual({ pluginKey: 'acme.notes', plugin: null })
    expect(deactivatePlugin).toHaveBeenCalledWith('acme.notes')
  })

  it('refuses unknown plugins and plugins without a worker', async () => {
    const deactivatePlugin = setup({})
    await expect(
      method('plugins.restart').handler({ pluginKey: 'acme.notes' }, context)
    ).rejects.toThrow(/no worker/)
    await expect(
      method('plugins.restart').handler({ pluginKey: 'acme.other' }, context)
    ).rejects.toThrow(/not installed/)
    expect(deactivatePlugin).not.toHaveBeenCalled()
  })
})

describe('plugins.getLogs', () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: plugin handlers never touch the runtime.
  const context: RpcContext = {
    runtime: {} as RpcContext['runtime'],
    caller: { kind: 'local-cli' }
  }

  it('passes the cursor through and returns the next one', async () => {
    const logs = new PluginLogBuffer()
    logs.append('acme.notes', 'info', 'one')
    const stub = {
      whenReady: vi.fn().mockResolvedValue(undefined),
      getLogsSince: (key: string, cursor?: string) => logs.since(key, cursor)
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: getLogs reads only the members stubbed above.
    setPluginServiceForRpc(stub as unknown as PluginService, {
      applyConsent: vi.fn(),
      applyEnablement: vi.fn()
    })
    const first = await method('plugins.getLogs').handler({ pluginKey: 'acme.notes' }, context)
    expect(first).toMatchObject({ lines: [{ line: 'one' }], cursor: expect.any(String) })
    logs.append('acme.notes', 'error', 'two')
    const after =
      typeof first === 'object' && first && 'cursor' in first && typeof first.cursor === 'string'
        ? first.cursor
        : ''
    await expect(
      method('plugins.getLogs').handler({ pluginKey: 'acme.notes', after }, context)
    ).resolves.toMatchObject({ lines: [{ line: 'two', level: 'error' }] })
  })

  it('accepts the optional cursor param, so older clients still parse', () => {
    expect(PluginGetLogsParams.safeParse({ pluginKey: 'acme.notes' }).success).toBe(true)
    expect(PluginGetLogsParams.safeParse({ pluginKey: 'acme.notes', after: 'x:1' }).success).toBe(
      true
    )
    expect(
      PluginGetLogsParams.safeParse({ pluginKey: 'acme.notes', after: 'x'.repeat(65) }).success
    ).toBe(false)
  })
})
