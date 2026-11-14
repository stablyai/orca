import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fingerprintPluginConsent } from '../../shared/plugins/approval/plugin-consent-fingerprint'
import { devFolderConsentIdentity } from './plugin-discovery'
import {
  pluginManifestSchema,
  type PluginManifest
} from '../../shared/plugins/manifest/plugin-manifest'
import type { PluginWorkerHandle } from './workers/parent-process/plugin-host-process-types'
import { PluginService } from './plugin-service'
import type { PluginWorkerFactory } from './workers/worker-supervision/plugin-worker-startup'

const roots: string[] = []
const services: PluginService[] = []
const pluginKey = 'samples.demo'

function manifest(options: { main?: string; capabilities?: PluginManifest['capabilities'] } = {}) {
  return pluginManifestSchema.parse({
    manifestVersion: 1,
    id: 'demo',
    publisher: 'samples',
    name: 'Demo',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    main: options.main ?? 'worker.js',
    contributes: {
      panels: [{ id: 'panel', title: 'Panel', entry: 'panel.html' }],
      commands: [{ id: 'run', title: 'Run' }],
      events: []
    },
    capabilities: options.capabilities ?? []
  })
}

async function pluginRoot(pluginManifest = manifest()): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-plugin-reconcile-'))
  roots.push(root)
  await writeFile(join(root, 'orca-plugin.json'), JSON.stringify(pluginManifest))
  await writeFile(join(root, 'worker.js'), 'export default async function () {}')
  await writeFile(join(root, 'worker-v2.js'), 'export default async function () {}')
  await writeFile(join(root, 'panel.html'), '<h1>Panel</h1>')
  return root
}

function testWorker(): PluginWorkerHandle & { dispose: ReturnType<typeof vi.fn> } {
  return {
    commands: ['run'],
    invokeCommand: vi.fn(async () => null),
    deliverEvent: vi.fn(),
    requestFromPanel: vi.fn(),
    runHook: vi.fn(),
    notifyDataChanged: vi.fn(),
    lastActivityAt: () => 1_000,
    inFlightCount: () => 0,
    dispose: vi.fn(async () => undefined),
    kill: vi.fn(),
    onExit: vi.fn()
  }
}

async function createHarness(root: string) {
  let enabled = true
  let disabled: string[] = []
  let devPaths = [root]
  let killed = false
  const consent = fingerprintPluginConsent(manifest(), await devFolderConsentIdentity(root))
  const workers: ReturnType<typeof testWorker>[] = []
  const factory = vi.fn<PluginWorkerFactory>(async () => {
    const handle = testWorker()
    workers.push(handle)
    return handle
  })
  const service = new PluginService({
    userDataPath: root,
    hostVersion: '1.4.0',
    isPluginSystemEnabled: () => enabled,
    getDisabledPlugins: () => disabled,
    getPluginConsents: () => ({ [pluginKey]: consent }),
    getDevPluginPaths: () => devPaths,
    getPluginKillListEntry: (key) =>
      killed && key === pluginKey
        ? { pluginKey, reason: 'Security incident', advisoryUrl: 'https://orca.example/advisory' }
        : null,
    workerFactory: factory
  })
  services.push(service)
  return {
    service,
    factory,
    workers,
    setEnabled: (value: boolean) => {
      enabled = value
    },
    setDisabled: (value: string[]) => {
      disabled = value
    },
    setDevPaths: (value: string[]) => {
      devPaths = value
    },
    setKilled: (value: boolean) => {
      killed = value
    }
  }
}

async function activate(service: PluginService): Promise<void> {
  await service.initialize()
  await service.invokeCommand(pluginKey, 'run')
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('PluginService worker reconciliation', () => {
  it('deactivates removed dev paths and makes a replacement folder wait for its own review', async () => {
    const firstRoot = await pluginRoot()
    const secondRoot = await pluginRoot()
    const harness = await createHarness(firstRoot)
    await activate(harness.service)

    harness.setDevPaths([])
    await harness.service.refresh()
    expect(harness.workers[0]!.dispose).toHaveBeenCalledOnce()
    expect(harness.service.findValidPlugin(pluginKey)).toBeNull()

    // Same key and capabilities, different folder: the first folder's approval must not carry over.
    harness.setDevPaths([secondRoot])
    await harness.service.refresh()
    const replacement = harness.service.findValidPlugin(pluginKey)
    expect(replacement && harness.service.activationState(replacement)).toBe('pending')
    await expect(harness.service.invokeCommand(pluginKey, 'run')).rejects.toThrow('not enabled')
    expect(harness.factory).toHaveBeenCalledTimes(1)
  })
})
