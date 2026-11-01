import { describe, expect, it, vi } from 'vitest'
import {
  exportedTypeShape,
  runtimeShape
} from '../../../shared/plugins/authoring/plugin-author-typings.test-fixture'
import { createPluginWorkerRuntime, type PluginWorkerOrcaApi } from './plugin-host-runtime'

async function activatedOrca(): Promise<PluginWorkerOrcaApi> {
  const captured: { orca?: PluginWorkerOrcaApi } = {}
  const runtime = createPluginWorkerRuntime({
    send: vi.fn(),
    exit: vi.fn(),
    importModule: async () => ({ default: (api: PluginWorkerOrcaApi) => (captured.orca = api) })
  })
  await runtime.handleMessage({
    orca: 1,
    kind: 'evt',
    event: 'init',
    payload: {
      pluginId: 'samples.demo',
      pluginRoot: '/plugin',
      mainEntry: 'main.mjs',
      grantedCapabilities: []
    }
  })
  if (!captured.orca) {
    throw new Error('activate was not called')
  }
  return captured.orca
}

describe('orca-worker.d.ts matches the activate(orca) object', () => {
  it('declares exactly the members a worker gets', async () => {
    const typings = exportedTypeShape('orca/worker', 'OrcaWorkerApi')
    expect(typings.optional).toEqual([])
    expect(runtimeShape(await activatedOrca())).toEqual(typings.shape)
  })
})
