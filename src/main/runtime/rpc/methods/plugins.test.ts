import { afterEach, describe, expect, it, vi } from 'vitest'
import { eraseRpcMethods, type RpcContext, type RpcMethod } from '../core'
import type { PluginService } from '../../../plugins/plugin-service'
import { PLUGIN_METHODS, setPluginServiceForRpc } from './plugins'

vi.mock('../../../plugins/plugin-client-list', () => ({
  listPluginsForClients: vi.fn().mockResolvedValue([])
}))

const SESSION_TOKEN = 's'.repeat(43)

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

function context(connectionId?: string): RpcContext {
  return { runtime: {} as RpcContext['runtime'], connectionId, clientId: 'paired-device' }
}

afterEach(() => setPluginServiceForRpc(null))

describe('plugin panel serve RPC identity', () => {
  it('leaves the raw panel envelope for session resolution and admission', () => {
    const schema = method('plugins.panelAction').params!

    expect(
      schema.safeParse({
        pluginId: 'samples.other',
        unexpected: 'x'.repeat(100_000)
      }).success
    ).toBe(true)
  })

  it('binds panel loading and actions to the same runtime connection owner', async () => {
    const service = {
      whenReady: vi.fn().mockResolvedValue(undefined),
      panels: {
        open: vi.fn().mockResolvedValue({ html: '<p>panel</p>', sessionToken: SESSION_TOKEN }),
        execute: vi.fn().mockResolvedValue({ ok: true, value: { branch: 'main' } }),
        bindOwnerSignal: vi.fn(),
        revokeOwner: vi.fn()
      }
    } as unknown as PluginService
    setPluginServiceForRpc(service)
    const rpcContext = context('connection-one')

    await expect(
      method('plugins.readPanelEntry').handler(
        { pluginKey: 'samples.demo', panelId: 'dashboard' },
        rpcContext
      )
    ).resolves.toEqual({ html: '<p>panel</p>', sessionToken: SESSION_TOKEN })
    expect(service.panels.open).toHaveBeenCalledWith(
      'runtime:connection-one',
      'samples.demo',
      'dashboard'
    )

    await expect(
      method('plugins.panelAction').handler(
        { sessionToken: SESSION_TOKEN, action: 'workspace.readContext', params: {} },
        rpcContext
      )
    ).resolves.toEqual({ outcome: { ok: true, value: { branch: 'main' } } })
    expect(service.panels.execute).toHaveBeenCalledWith('runtime:connection-one', {
      sessionToken: SESSION_TOKEN,
      action: 'workspace.readContext',
      params: {}
    })
  })
})

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
