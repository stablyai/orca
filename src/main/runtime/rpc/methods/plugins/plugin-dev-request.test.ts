import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fingerprintPluginConsent } from '../../../../../shared/plugins/approval/plugin-consent-fingerprint'
import { pluginManifestSchema } from '../../../../../shared/plugins/manifest/plugin-manifest'

import { installPluginFromLocalPath } from '../../../../plugins/installation/plugin-install'
import {
  devFolderConsentIdentity,
  getUserPluginsDir
} from '../../../../plugins/discovery/plugin-discovery'
import { PluginService } from '../../../../plugins/plugin-service'
import type {
  PluginWorkerHandle,
  PluginWorkerPanelRequest
} from '../../../../plugins/workers/parent-process/plugin-host-process-types'

import type { PluginWorkerFactory } from '../../../../plugins/workers/worker-supervision/plugin-worker-startup'
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

function requestMethod(name: string) {
  const method = eraseRpcMethods(PLUGIN_DEV_REQUEST_METHODS).find(
    (candidate) => candidate.name === name
  )
  if (!method || 'stream' in method) {
    throw new Error(`${name} is missing`)
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
  const userDataPath = await realpath(await mkdtemp(join(tmpdir(), 'orca-request-profile-')))
  roots.push(userDataPath)
  let consent = fingerprintPluginConsent(manifest, await devFolderConsentIdentity(root))
  let pluginKey = 'samples.demo'
  if (options.dev === false) {
    const installed = await installPluginFromLocalPath({
      pluginsDir: getUserPluginsDir(userDataPath),
      sourcePath: root,
      hostVersion: '1.4.267'
    })
    if (!installed.ok) {
      throw new Error(installed.error)
    }
    consent = installed.consentFingerprint
    pluginKey = installed.pluginKey
  }
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
    userDataPath,
    hostVersion: '1.4.267',
    isPluginSystemEnabled: () => true,
    getDisabledPlugins: () => [],
    getPluginConsents: (): Record<string, string> =>
      options.approved === false ? {} : { [pluginKey]: consent },
    getDevPluginPaths: () => (options.dev === false ? [] : [root]),
    workerFactory: factory
  })
  services.push(service)
  await service.initialize()
  setPluginServiceForRpc(service, { applyConsent: vi.fn(), applyEnablement: vi.fn() })
  return { pluginKey, factory }
}

describe('plugins.devRequest', () => {
  it('refuses an unapproved plugin without starting its worker', async () => {
    const { factory } = await realService({ answer: async () => null, approved: false })
    await expect(
      requestMethod('plugins.devRequest').handler(
        { pluginKey: 'samples.demo', name: 'count' },
        context
      )
    ).rejects.toThrow(/not approved and enabled/)
    expect(factory).not.toHaveBeenCalled()
  })
})

describe('plugins.request', () => {
  it('only dispatches the exact CLI handler approved for an installed plugin', async () => {
    const { pluginKey, factory } = await realService({
      dev: false,
      raw: {
        ...WORKER_MANIFEST,
        engines: { orca: '>=1.4.267' },
        capabilities: [{ kind: 'workspace:read' }, { kind: 'cli:request', handler: 'notes.list' }]
      },
      answer: async ({ name, input, panel }) => ({ name, input, caller: panel.contributionId })
    })
    const method = requestMethod('plugins.request')
    await expect(
      method.handler({ pluginKey, name: 'notes.list.private' }, context)
    ).rejects.toThrow(/does not expose/)
    await expect(
      requestMethod('plugins.devRequest').handler(
        { pluginKey, name: 'notes.list.private' },
        context
      )
    ).rejects.toThrow(/installed plugin/)
    await expect(
      method.handler({ pluginKey, name: 'notes.list', input: 'x'.repeat(65537) }, context)
    ).rejects.toThrow(/panel request limit/)
    expect(factory).not.toHaveBeenCalled()
    await expect(
      method.handler({ pluginKey, name: 'notes.list', input: false }, context)
    ).resolves.toEqual({
      pluginKey,
      name: 'notes.list',
      result: { name: 'notes.list', input: false, caller: 'orca-cli' }
    })
  })
})
