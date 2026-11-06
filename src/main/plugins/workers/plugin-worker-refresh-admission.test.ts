import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { fingerprintPluginConsent } from '../../../shared/plugins/approval/plugin-consent-fingerprint'
import { devFolderConsentIdentity } from '../plugin-discovery'
import { pluginManifestSchema } from '../../../shared/plugins/manifest/plugin-manifest'
import { hashPluginTree } from '../plugin-content-hash'
import type { PluginWorkerHandle } from './plugin-host-process'
import { PluginService } from '../plugin-service'
import type { PluginWorkerFactory } from './plugin-worker-manager'

const roots: string[] = []
const services: PluginService[] = []
const pluginKey = 'samples.demo'

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function worker(): PluginWorkerHandle & { exit: () => void } {
  const exits: ((code: number | null) => void)[] = []
  return {
    commands: ['run'],
    invokeCommand: vi.fn(async () => null),
    deliverEvent: vi.fn(),
    requestFromPanel: vi.fn(),
    runHook: vi.fn(),
    notifyDataChanged: vi.fn(),
    // ast-grep-ignore: test-no-wall-clock -- idle checks compare against the real clock, so "now" keeps the worker active
    lastActivityAt: () => Date.now(),
    inFlightCount: () => 0,
    dispose: vi.fn(async () => undefined),
    kill: vi.fn(),
    onExit: (callback) => exits.push(callback),
    exit: () => exits.forEach((callback) => callback(1))
  }
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'orca-plugin-refresh-admission-'))
  const userDataPath = await mkdtemp(join(tmpdir(), 'orca-plugin-refresh-user-data-'))
  roots.push(root, userDataPath)
  const manifest = pluginManifestSchema.parse({
    manifestVersion: 1,
    id: 'demo',
    publisher: 'samples',
    name: 'Demo',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    main: 'main.mjs',
    contributes: {
      commands: [{ id: 'run', title: 'Run' }],
      keybindings: [{ command: 'run', key: 'Mod+Alt+Q' }]
    },
    capabilities: []
  })
  await writeFile(join(root, 'orca-plugin.json'), JSON.stringify(manifest))
  await writeFile(join(root, 'main.mjs'), 'export default () => {}')
  const hash = await hashPluginTree(root)
  if (!hash.ok) {
    throw new Error(hash.error)
  }
  let consent = fingerprintPluginConsent(manifest, await devFolderConsentIdentity(root, hash.hash))
  let disabled: string[] = []
  let devPaths = [root]
  const first = worker()
  const factory = vi.fn<PluginWorkerFactory>().mockResolvedValue(first)
  const service = new PluginService({
    userDataPath,
    hostVersion: '1.4.0',
    isPluginSystemEnabled: () => true,
    getDisabledPlugins: () => disabled,
    getDevPluginPaths: () => devPaths,
    getPluginConsents: () => ({ [pluginKey]: consent }),
    workerFactory: factory
  })
  services.push(service)
  await service.initialize()
  return {
    service,
    first,
    factory,
    root,
    manifest,
    revoke: () => {
      consent = ''
    },
    disable: () => {
      disabled = [pluginKey]
    },
    remove: () => {
      devPaths = []
    }
  }
}

it.each(['revoke', 'disable', 'remove', 'changed spec', 'changed content'] as const)(
  'rejects old activation after %s, including a discovery refresh',
  async (change) => {
    const subject = await harness()
    const { service, first, factory, root, manifest } = subject
    let finish!: (handle: PluginWorkerHandle) => void
    factory.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const previousHash = service.findValidPlugin(pluginKey)?.consentContentHash
    const activation = service.invokeCommand(pluginKey, 'run')
    const result = expect(activation).rejects.toThrow(/changed|approved|cancelled/)
    await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce())
    if (change === 'revoke') {
      subject.revoke()
    }
    if (change === 'disable') {
      subject.disable()
    }
    if (change === 'remove') {
      subject.remove()
    }
    if (change === 'changed spec') {
      await writeFile(
        join(root, 'orca-plugin.json'),
        JSON.stringify({ ...manifest, version: '2.0.0' })
      )
    }
    if (change === 'changed content') {
      await writeFile(join(root, 'main.mjs'), 'export default () => { 2 }')
    }
    // Discovery publishes before reconciliation waits for the old activation to stop.
    const refresh = service.refresh()
    await vi.waitFor(() => {
      const current = service.findValidPlugin(pluginKey)
      if (change === 'remove') {
        expect(current).toBeNull()
      } else if (change === 'revoke' || change === 'disable') {
        expect(current && service.activationState(current)).not.toBe('approved')
      } else if (change === 'changed spec') {
        expect(current?.manifest.version).toBe('2.0.0')
      } else {
        expect(current?.consentContentHash).not.toBe(previousHash)
      }
    })
    finish(first)
    await result
    await refresh
    expect(factory).toHaveBeenCalledOnce()
    first.exit()
    expect(service.workerState(pluginKey).state).toBe('inactive')
  }
)
