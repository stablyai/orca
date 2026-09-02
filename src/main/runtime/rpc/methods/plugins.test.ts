import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext, RpcMethod } from '../core'
import type { PluginService } from '../../../plugins/plugin-service'
import { PLUGIN_METHODS, setPluginServiceForRpc } from './plugins'

const SESSION_TOKEN = 's'.repeat(43)

function method(name: string): RpcMethod {
  const found = PLUGIN_METHODS.find((entry) => entry.name === name)
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
        pluginId: 'orca-samples.other',
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
        { pluginKey: 'orca-samples.demo', panelId: 'dashboard' },
        rpcContext
      )
    ).resolves.toEqual({ html: '<p>panel</p>', sessionToken: SESSION_TOKEN })
    expect(service.panels.open).toHaveBeenCalledWith(
      'runtime:connection-one',
      'orca-samples.demo',
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
