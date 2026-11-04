import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fingerprintPluginConsent } from '../../../../shared/plugins/approval/plugin-consent-fingerprint'
import { pluginManifestSchema } from '../../../../shared/plugins/manifest/plugin-manifest'
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
  id: 'guard',
  publisher: 'samples',
  name: 'Guard',
  version: '1.0.0',
  engines: { orca: '>=1.4.248' },
  pluginApi: 1,
  main: 'worker.js',
  contributes: { hooks: [{ event: 'terminal.send' }] }
})

function devHook() {
  const method = eraseRpcMethods(PLUGIN_DEV_EMIT_METHODS).find(
    (candidate) => candidate.name === 'plugins.devHook'
  )
  if (!method || 'stream' in method) {
    throw new Error('plugins.devHook is missing')
  }
  return method
}

async function realService(answer: (payload: unknown) => unknown) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-dev-hook-rpc-')))
  roots.push(root)
  await writeFile(join(root, 'orca-plugin.json'), JSON.stringify(manifest))
  await writeFile(join(root, 'worker.js'), 'export default function activate() {}')
  const consent = fingerprintPluginConsent(manifest, await devFolderConsentIdentity(root))
  const runHook = vi.fn(async (_event: string, payload: unknown) => answer(payload))
  const factory = vi.fn<PluginWorkerFactory>(async (): Promise<PluginWorkerHandle> => ({
    commands: [],
    invokeCommand: vi.fn(async () => null),
    requestFromPanel: vi.fn(),
    runHook,
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
    hostVersion: '1.4.248',
    isPluginSystemEnabled: () => true,
    getDisabledPlugins: () => [],
    getPluginConsents: () => ({ 'samples.guard': consent }),
    getDevPluginPaths: () => [root],
    workerFactory: factory
  })
  services.push(service)
  await service.initialize()
  setPluginServiceForRpc(service, { applyConsent: vi.fn(), applyEnablement: vi.fn() })
  return { root, runHook }
}

const SEND = { terminalId: 't1', text: 'rm -rf /', enter: true, inputKind: 'driving' }

describe('plugins.devHook', () => {
  it('runs the hook through the dev plugin and returns the decision', async () => {
    const { root, runHook } = await realService(() => ({
      decision: 'result',
      result: { deny: 'blocked' }
    }))
    await expect(
      devHook().handler({ path: root, event: 'terminal.send', payload: SEND }, context)
    ).resolves.toEqual({
      pluginKey: 'samples.guard',
      event: 'terminal.send',
      decision: { kind: 'deny', reason: 'blocked' }
    })
    expect(runHook).toHaveBeenCalledWith('terminal.send', SEND, 2_000)
  })

  it('returns the changed event, and refuses unknown, unlisted or invalid input', async () => {
    const { root } = await realService((payload) => ({
      decision: 'continue',
      payload: { ...Object(payload), text: 'ls' }
    }))
    await expect(
      devHook().handler({ path: root, event: 'terminal.send', payload: SEND }, context)
    ).resolves.toMatchObject({ decision: { kind: 'continue', event: { ...SEND, text: 'ls' } } })
    await expect(
      devHook().handler({ path: root, event: 'terminal.write', payload: SEND }, context)
    ).rejects.toThrow(/not an Orca plugin hook/)
    await expect(
      devHook().handler({ path: root, event: 'agent.prompt.before', payload: {} }, context)
    ).rejects.toThrow(/does not list agent.prompt.before/)
    await expect(
      devHook().handler({ path: root, event: 'terminal.send', payload: { text: 1 } }, context)
    ).rejects.toThrow(/not a valid terminal.send event/)
  })
})
