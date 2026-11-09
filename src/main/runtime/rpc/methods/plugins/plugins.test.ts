import { afterEach, describe, expect, it, vi } from 'vitest'
import { eraseRpcMethods, type RpcContext, type RpcMethod } from '../../core'
import type { PluginService } from '../../../../plugins/plugin-service'
import { PLUGIN_METHODS, setPluginServiceForRpc } from './plugins'
import { PluginLogBuffer } from '../../../../plugins/plugin-log-buffer'
import '../../../../../shared/rpc-contract/plugins-params'

vi.mock('../../../../plugins/plugin-client-list', () => ({
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
})
