import { afterEach, describe, expect, it, vi } from 'vitest'
import { eraseRpcMethods, type RpcContext, type RpcMethod } from '../core'
import type { PluginService } from '../../../plugins/plugin-service'
import { PLUGIN_METHODS, setPluginServiceForRpc } from './plugins'

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
