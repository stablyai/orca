import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fingerprintPluginConsent } from '../../../../../shared/plugins/approval/plugin-consent-fingerprint'
import { pluginManifestSchema } from '../../../../../shared/plugins/manifest/plugin-manifest'

import { devFolderConsentIdentity } from '../../../../plugins/plugin-discovery'
import { PluginService } from '../../../../plugins/plugin-service'
import type {
  PluginWorkerHandle,
  PluginWorkerPanelRequest
} from '../../../../plugins/workers/plugin-host-process-types'

import type { PluginWorkerFactory } from '../../../../plugins/workers/plugin-worker-startup'
import { eraseRpcMethods, type RpcContext } from '../../core'
import { PLUGIN_DEV_REQUEST_METHODS } from './plugin-dev-request'
import { setPluginServiceForRpc } from './plugins'

const roots: string[] = []
const services: PluginService[] = []

afterEach(async () => {
  setPluginServiceForRpc(null)
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: plugin handlers never touch the runtime.
const context: RpcContext = { runtime: {} as RpcContext['runtime'], caller: { kind: 'local-cli' } }

const WORKER_MANIFEST = {
  manifestVersion: 1,
  id: 'demo',
  publisher: 'samples',
  name: 'Demo',
  version: '1.0.0',
  engines: { orca: '>=1.0.0' },
  pluginApi: 1,
  main: 'worker.js',
  contributes: { events: [{ on: 'workspace.created' }] },
  capabilities: [{ kind: 'workspace:read' }]
}

function devRequest() {
  const method = eraseRpcMethods(PLUGIN_DEV_REQUEST_METHODS)[0]
  if (!method || 'stream' in method) {
    throw new Error('plugins.devRequest is missing')
  }
  return method
}

async function realService(options: {
  answer: (request: PluginWorkerPanelRequest) => Promise<unknown>
  raw?: Record<string, unknown>
  approved?: boolean
  dev?: boolean
}) {
  const raw = options.raw ?? WORKER_MANIFEST
  const manifest = pluginManifestSchema.parse(raw)
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-dev-request-rpc-')))
  roots.push(root)
  await writeFile(join(root, 'orca-plugin.json'), JSON.stringify(raw))
  await writeFile(join(root, 'worker.js'), 'export function activate() {}')
  const consent = fingerprintPluginConsent(manifest, await devFolderConsentIdentity(root))
  const requestFromPanel = vi.fn(options.answer)
  const factory = vi.fn<PluginWorkerFactory>(async (): Promise<PluginWorkerHandle> => ({
    commands: [],
    invokeCommand: vi.fn(async () => null),
    requestFromPanel,
    runHook: vi.fn(),
    notifyDataChanged: vi.fn(),
    deliverEvent: vi.fn(),
    lastActivityAt: () => 1_700_000_000_000,
    inFlightCount: () => 0,
    dispose: vi.fn(async () => undefined),
    kill: vi.fn(),
    onExit: vi.fn()
  }))
  const service = new PluginService({
    userDataPath: root,
    hostVersion: '1.4.0',
    isPluginSystemEnabled: () => true,
    getDisabledPlugins: () => [],
    getPluginConsents: (): Record<string, string> =>
      options.approved === false ? {} : { 'samples.demo': consent },
    getDevPluginPaths: () => (options.dev === false ? [] : [root]),
    workerFactory: factory
  })
  services.push(service)
  await service.initialize()
  setPluginServiceForRpc(service, { applyConsent: vi.fn(), applyEnablement: vi.fn() })
  return { root, factory, requestFromPanel }
}

describe('plugins.devRequest', () => {
  it('refuses an unapproved plugin without starting its worker', async () => {
    const { factory } = await realService({ answer: async () => null, approved: false })
    await expect(
      devRequest().handler({ pluginKey: 'samples.demo', name: 'count' }, context)
    ).rejects.toThrow(/not approved and enabled/)
    expect(factory).not.toHaveBeenCalled()
  })
})
