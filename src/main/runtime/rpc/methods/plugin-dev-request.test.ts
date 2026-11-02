import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fingerprintPluginConsent } from '../../../../shared/plugins/approval/plugin-consent-fingerprint'
import { pluginManifestSchema } from '../../../../shared/plugins/manifest/plugin-manifest'
import { PluginDevRequestParams } from '../../../../shared/rpc-contract/plugins-params'
import { devFolderConsentIdentity } from '../../../plugins/plugin-discovery'
import { PluginService } from '../../../plugins/plugin-service'
import type { PluginWorkerHandle } from '../../../plugins/workers/plugin-host-process'
import type { PluginWorkerPanelRequest } from '../../../plugins/workers/plugin-host-process-types'
import type { PluginWorkerFactory } from '../../../plugins/workers/plugin-worker-manager'
import { eraseRpcMethods, type RpcContext } from '../core'
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

function workerError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

describe('plugins.devRequest', () => {
  it('takes exactly one of a folder or a plugin key and a bridge name', () => {
    expect(PluginDevRequestParams.safeParse({ name: 'count' }).success).toBe(false)
    expect(PluginDevRequestParams.safeParse({ pluginKey: 'a.b', name: 'bad name' }).success).toBe(
      false
    )
    expect(
      PluginDevRequestParams.safeParse({ pluginKey: 'a.b', name: 'count', input: { n: 1 } }).success
    ).toBe(true)
  })

  it("starts the worker and answers with the handler's result, as a panel would", async () => {
    const { root, factory, requestFromPanel } = await realService({
      answer: async () => ({ count: 3 })
    })
    await expect(
      devRequest().handler({ path: root, name: 'count', input: { by: 1 }, panel: 'p1' }, context)
    ).resolves.toEqual({ pluginKey: 'samples.demo', name: 'count', result: { count: 3 } })
    expect(factory).toHaveBeenCalledOnce()
    expect(requestFromPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'count',
        input: { by: 1 },
        panel: { id: 'p1', surface: 'panel', contributionId: 'orca-cli' },
        timeoutMs: 30_000
      })
    )
  })

  it('sends null input when --data is omitted, like plugin.request(name)', async () => {
    const { requestFromPanel } = await realService({ answer: async () => null })
    await devRequest().handler({ pluginKey: 'samples.demo', name: 'ping' }, context)
    expect(requestFromPanel.mock.calls[0]?.[0]).toMatchObject({ input: null })
  })

  it.each([
    ['unknown_method', 'no panel handler named nope', /orca\.panels\.handle\('nope'/],
    ['timeout', 'nope timed out after 30000ms', /--timeout-ms/]
  ])('maps a worker %s to plugin_request_failed', async (code, message, step) => {
    await realService({
      answer: async () => {
        throw workerError(code, message)
      }
    })
    const failure = devRequest().handler({ pluginKey: 'samples.demo', name: 'nope' }, context)
    await expect(failure).rejects.toMatchObject({
      code: 'plugin_request_failed',
      data: { requestCode: code, nextSteps: [expect.stringMatching(step)] }
    })
  })

  it('refuses an installed (non-dev) plugin key', async () => {
    const { factory } = await realService({ answer: async () => null, dev: false })
    await expect(
      devRequest().handler({ pluginKey: 'samples.demo', name: 'count' }, context)
    ).rejects.toMatchObject({ code: 'plugin_not_found' })
    expect(factory).not.toHaveBeenCalled()
  })

  it('refuses an unapproved plugin without starting its worker', async () => {
    const { factory } = await realService({ answer: async () => null, approved: false })
    await expect(
      devRequest().handler({ pluginKey: 'samples.demo', name: 'count' }, context)
    ).rejects.toThrow(/not approved and enabled/)
    expect(factory).not.toHaveBeenCalled()
  })

  it('refuses a plugin with no worker', async () => {
    const { factory } = await realService({
      answer: async () => null,
      raw: {
        ...WORKER_MANIFEST,
        main: undefined,
        contributes: {},
        capabilities: []
      }
    })
    await expect(
      devRequest().handler({ pluginKey: 'samples.demo', name: 'count' }, context)
    ).rejects.toThrow(/has no worker to answer count/)
    expect(factory).not.toHaveBeenCalled()
  })
})
