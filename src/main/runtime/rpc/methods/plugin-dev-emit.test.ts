import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fingerprintPluginConsent } from '../../../../shared/plugins/approval/plugin-consent-fingerprint'
import { pluginManifestSchema } from '../../../../shared/plugins/manifest/plugin-manifest'
import { PluginDevEmitParams } from '../../../../shared/rpc-contract/plugins-params'
import { devFolderConsentIdentity } from '../../../plugins/plugin-discovery'
import { PluginService } from '../../../plugins/plugin-service'
import type { PluginWorkerHandle } from '../../../plugins/workers/plugin-host-process'
import type { PluginWorkerFactory } from '../../../plugins/workers/plugin-worker-manager'
import { eraseRpcMethods, type RpcContext } from '../core'
import { PLUGIN_DEV_EMIT_METHODS } from './plugin-dev-emit'
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

const manifest = pluginManifestSchema.parse({
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
})

function devEmit() {
  const method = eraseRpcMethods(PLUGIN_DEV_EMIT_METHODS)[0]
  if (!method || 'stream' in method) {
    throw new Error('plugins.devEmit is missing')
  }
  return method
}

async function realService() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-dev-emit-rpc-')))
  roots.push(root)
  await writeFile(join(root, 'orca-plugin.json'), JSON.stringify(manifest))
  await writeFile(join(root, 'worker.js'), 'export function activate() {}')
  const consent = fingerprintPluginConsent(manifest, await devFolderConsentIdentity(root))
  const deliverEvent = vi.fn()
  const factory = vi.fn<PluginWorkerFactory>(async (): Promise<PluginWorkerHandle> => ({
    commands: [],
    invokeCommand: vi.fn(async () => null),
    requestFromPanel: vi.fn(),
    notifyDataChanged: vi.fn(),
    deliverEvent,
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
    getPluginConsents: () => ({ 'samples.demo': consent }),
    getDevPluginPaths: () => [root],
    workerFactory: factory
  })
  services.push(service)
  await service.initialize()
  setPluginServiceForRpc(service, { applyConsent: vi.fn(), applyEnablement: vi.fn() })
  return { root, factory, deliverEvent }
}

const CREATED = { workspaceId: 'wt-1', kind: 'worktree', path: '/repo', branch: 'main' }

describe('plugins.devEmit', () => {
  it('takes exactly one of a folder or a plugin key', () => {
    expect(PluginDevEmitParams.safeParse({ event: 'workspace.created' }).success).toBe(false)
    expect(
      PluginDevEmitParams.safeParse({ pluginKey: 'a.b', path: '/x', event: 'workspace.created' })
        .success
    ).toBe(false)
    expect(
      PluginDevEmitParams.safeParse({ pluginKey: 'a.b', event: 'workspace.created' }).success
    ).toBe(true)
  })

  it('starts the real worker path and delivers the payload', async () => {
    const { root, factory, deliverEvent } = await realService()
    await expect(
      devEmit().handler({ path: root, event: 'workspace.created', payload: CREATED }, context)
    ).resolves.toEqual({
      pluginKey: 'samples.demo',
      event: 'workspace.created',
      delivered: { worker: true, panels: 0 }
    })
    expect(factory).toHaveBeenCalledOnce()
    expect(deliverEvent).toHaveBeenCalledWith('workspace.created', CREATED)
  })

  it('refuses an event the manifest does not declare without starting the worker', async () => {
    const { factory } = await realService()
    await expect(
      devEmit().handler(
        {
          pluginKey: 'samples.demo',
          event: 'workspace.removed',
          payload: { workspaceId: 'wt-1', kind: 'worktree', path: '/repo' }
        },
        context
      )
    ).rejects.toThrow(/Nothing in samples.demo listens for workspace.removed/)
    expect(factory).not.toHaveBeenCalled()
  })
})
