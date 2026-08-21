import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fingerprintPluginConsent } from '../../shared/plugins/plugin-consent-fingerprint'
import { pluginManifestSchema, type PluginManifest } from '../../shared/plugins/plugin-manifest'
import { hashPluginTree } from './plugin-content-hash'
import { PluginContentVerifier } from './plugin-content-integrity'
import { PluginService } from './plugin-service'
import type { PluginWorkerFactory } from './plugin-worker-manager'

const roots: string[] = []

async function createInstalledPlugin(options: { worker: boolean }): Promise<{
  userDataPath: string
  pluginKey: string
  rootDir: string
  manifest: PluginManifest
}> {
  const userDataPath = await mkdtemp(join(tmpdir(), 'orca-plugin-service-integrity-'))
  roots.push(userDataPath)
  const pluginKey = 'orca-samples.demo'
  const pluginDir = join(userDataPath, 'plugins', pluginKey)
  const stagingDir = join(pluginDir, 'staging')
  await mkdir(stagingDir, { recursive: true })
  const manifest = pluginManifestSchema.parse({
    manifestVersion: 1,
    id: 'demo',
    publisher: 'orca-samples',
    name: 'Demo',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    ...(options.worker ? { main: 'worker.js' } : {}),
    contributes: {
      panels: [{ id: 'panel', title: 'Panel', entry: 'panel.html' }],
      commands: options.worker ? [{ id: 'run', title: 'Run' }] : [],
      events: []
    },
    capabilities: []
  })
  await writeFile(join(stagingDir, 'orca-plugin.json'), JSON.stringify(manifest))
  await writeFile(join(stagingDir, 'panel.html'), '<h1>Panel</h1>')
  await writeFile(join(stagingDir, 'payload.txt'), 'original')
  if (options.worker) {
    await writeFile(join(stagingDir, 'worker.js'), 'export default async function () {}')
  }
  const content = await hashPluginTree(stagingDir)
  if (!content.ok) {
    throw new Error(content.error)
  }
  const rootDir = join(pluginDir, content.hash)
  await rename(stagingDir, rootDir)
  await writeFile(join(pluginDir, 'current'), content.hash)
  return { userDataPath, pluginKey, rootDir, manifest }
}

function createService(
  plugin: Awaited<ReturnType<typeof createInstalledPlugin>>,
  workerFactory?: PluginWorkerFactory
): PluginService {
  const consentFingerprint = fingerprintPluginConsent(plugin.manifest)
  return new PluginService({
    userDataPath: plugin.userDataPath,
    hostVersion: '1.4.0',
    isPluginSystemEnabled: () => true,
    getDisabledPlugins: () => [],
    getPluginConsents: () => ({ [plugin.pluginKey]: consentFingerprint }),
    getDevPluginPaths: () => [],
    workerFactory
  })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('PluginService lazy content verification', () => {
  it('does not share an in-flight verification across same-key content revisions', async () => {
    const oldPlugin = await createInstalledPlugin({ worker: false })
    const newPlugin = await createInstalledPlugin({ worker: false })
    await writeFile(join(oldPlugin.rootDir, 'payload.txt'), 'tampered old revision')
    const verifier = new PluginContentVerifier()

    const oldVerification = verifier.verify({
      pluginKey: oldPlugin.pluginKey,
      rootDir: oldPlugin.rootDir,
      contentHash: basename(oldPlugin.rootDir)
    })
    const newVerification = verifier.verify({
      pluginKey: newPlugin.pluginKey,
      rootDir: newPlugin.rootDir,
      contentHash: basename(newPlugin.rootDir)
    })

    await expect(oldVerification).rejects.toThrow('integrity verification')
    await expect(newVerification).resolves.toBeUndefined()
  })

  it('detects tampering only when panel code is first consumed', async () => {
    const plugin = await createInstalledPlugin({ worker: false })
    const service = createService(plugin)
    await service.initialize()
    expect(service.findValidPlugin(plugin.pluginKey)).not.toBeNull()

    await writeFile(join(plugin.rootDir, 'payload.txt'), 'tampered after discovery')

    await expect(service.panels.readEntry(plugin.pluginKey, 'panel')).resolves.toBeNull()
    await service.dispose()
  })

  it('blocks a worker fork when installed content changed after discovery', async () => {
    const plugin = await createInstalledPlugin({ worker: true })
    const workerFactory = vi.fn<PluginWorkerFactory>()
    const service = createService(plugin, workerFactory)
    await service.initialize()
    await writeFile(join(plugin.rootDir, 'payload.txt'), 'tampered after discovery')

    await expect(service.invokeCommand(plugin.pluginKey, 'run')).rejects.toThrow(
      'integrity verification'
    )
    expect(workerFactory).not.toHaveBeenCalled()
    await service.dispose()
  })
})
