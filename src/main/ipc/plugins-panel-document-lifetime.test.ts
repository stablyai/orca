import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pluginManifestSchema } from '../../shared/plugins/manifest/plugin-manifest'
import type { Store } from '../persistence/loading-store/store'
import { PluginContentVerifier } from '../plugins/plugin-content-integrity'
import type { ValidDiscoveredPlugin } from '../plugins/plugin-discovery'
import { PluginPanelController } from '../plugins/panels/plugin-panel-controller'
import type { PluginService } from '../plugins/plugin-service'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => Promise<unknown>>()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, args: unknown) => Promise<unknown>) =>
      mocks.handlers.set(name, handler)
  }
}))

// The real guest session needs Electron; these cases pin ownership, which guests do not change.
vi.mock('../plugins/panels/guest-isolation/plugin-frame-guest-sessions', () => ({
  bindPluginFrameGuests: () => {},
  clearPluginFrameStorage: async () => {},
  preparePluginFrameGuest: async () => guestSetup.result
}))
const guestSetup = vi.hoisted(() => {
  const setup: { result: { partition: string; url: string } | null } = {
    result: { partition: 'persist:orca-plugin-test', url: 'x' }
  }
  return setup
})

const { registerPluginHandlers } = await import('./plugins')
const roots: string[] = []
const controllers: PluginPanelController[] = []
const senders: EventEmitter[] = []
const SUCCESSOR = 'orca-samples.successor'

// Why srcdoc by default: these cases pin ownership across a slow, verified entry load.
beforeEach(() => {
  mocks.handlers.clear()
  vi.stubEnv('ORCA_PLUGIN_ISOLATED_FRAMES', '0')
})
afterEach(async () => {
  for (const sender of senders.splice(0)) {
    sender.emit('destroyed')
  }
  for (const controller of controllers.splice(0)) {
    controller.dispose()
  }
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function plugin(id: string): Promise<ValidDiscoveredPlugin> {
  const rootDir = await mkdtemp(join(tmpdir(), 'orca-panel-document-'))
  roots.push(rootDir)
  await writeFile(join(rootDir, 'panel.html'), `<h1>${id}</h1>`)
  return {
    pluginKey: `orca-samples.${id}`,
    rootDir,
    contentHash: null,
    consentFingerprint: 'approved',
    isDev: true,
    manifest: pluginManifestSchema.parse({
      manifestVersion: 1,
      id,
      publisher: 'orca-samples',
      name: id,
      version: '1.0.0',
      engines: { orca: '>=1.0.0' },
      pluginApi: 1,
      contributes: { panels: [{ id: 'panel', title: id, entry: 'panel.html' }] },
      capabilities: [{ kind: 'notifications:show' }]
    })
  }
}

async function harness(
  options: {
    beforeVerify?: (plugin: ValidDiscoveredPlugin) => Promise<void>
    whenReady?: () => Promise<void>
  } = {}
) {
  const plugins = new Map(
    (await Promise.all([plugin('predecessor'), plugin('successor')])).map((entry) => [
      entry.pluginKey,
      entry
    ])
  )
  const verifier = new PluginContentVerifier()
  const verified: string[] = []
  const panels = new PluginPanelController({
    resolveApprovedPlugin: (key) => plugins.get(key) ?? null,
    contentVerifier: {
      verify: async (entry) => {
        verified.push(entry.pluginKey)
        const discovered = plugins.get(entry.pluginKey)
        if (!discovered) {
          throw new Error('Missing approved plugin')
        }
        await options.beforeVerify?.(discovered)
        await verifier.verify(entry)
      }
    },
    executeHostCall: async (pluginKey) => ({ ok: true, value: { pluginKey } }),
    log: () => () => {}
  })
  controllers.push(panels)
  // No isolated guests here: these cases pin session ownership, which guests do not change.
  const service = {
    panels,
    whenReady: options.whenReady ?? (async () => {}),
    findApprovedPlugin: () => null,
    getDiscovered: () => [],
    options: {}
  }
  registerPluginHandlers(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: frame entry handlers read only getSettings for the isolation switch.
    { getSettings: () => ({}) } as unknown as Store,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: panel handlers consume real controller, readiness and plugin lookup members only.
    service as unknown as PluginService
  )
  return { verified }
}

function sender(id = 1) {
  const contents = Object.assign(new EventEmitter(), { id })
  senders.push(contents)
  return contents
}

function invoke(name: string, contents: ReturnType<typeof sender>, args: unknown) {
  const handler = mocks.handlers.get(`plugins:${name}`)
  if (!handler) {
    throw new Error(`Missing handler ${name}`)
  }
  return handler({ sender: contents }, args)
}

function open(contents: ReturnType<typeof sender>, pluginKey = SUCCESSOR) {
  return invoke('readPanelEntry', contents, { pluginKey, panelId: 'panel' })
}

describe('plugin panel document ownership', () => {
  it('fails closed when the isolated guest cannot be set up', async () => {
    vi.stubEnv('ORCA_PLUGIN_ISOLATED_FRAMES', '1')
    await harness()
    guestSetup.result = null
    try {
      await expect(open(sender())).resolves.toBeNull()
    } finally {
      guestSetup.result = { partition: 'persist:orca-plugin-test', url: 'x' }
    }
  })
})
