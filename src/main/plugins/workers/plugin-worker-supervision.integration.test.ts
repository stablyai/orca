import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ValidDiscoveredPlugin } from '../discovery/plugin-discovery'
import { PluginPanelBridge } from '../panels/plugin-panel-bridge'
import { PluginWorkerManager } from './plugin-worker-manager'
import type { PluginWorkerSpawnSpec } from './worker-supervision/plugin-worker-startup'

const pluginRoots: string[] = []
const managers: PluginWorkerManager[] = []
let bundleRoot = ''
let hostEntryPath = ''

function createStateNotifications(): {
  notify: () => void
  waitFor: (predicate: () => boolean, description: string, timeoutMs?: number) => Promise<void>
} {
  const listeners = new Set<() => void>()
  return {
    notify: () => {
      for (const listener of listeners) {
        listener()
      }
    },
    waitFor: (predicate, description, timeoutMs = 10_000) => {
      if (predicate()) {
        return Promise.resolve()
      }
      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          listeners.delete(check)
          reject(new Error(`timed out waiting for ${description}`))
        }, timeoutMs)
        const check = (): void => {
          if (!predicate()) {
            return
          }
          clearTimeout(timeout)
          listeners.delete(check)
          resolve()
        }
        listeners.add(check)
      })
    }
  }
}

beforeAll(async () => {
  bundleRoot = await mkdtemp(join(tmpdir(), 'orca-plugin-host-bundle-'))
  hostEntryPath = join(bundleRoot, 'plugin-host-entry.cjs')
  await build({
    entryPoints: [join(process.cwd(), 'src', 'main', 'plugins', 'workers', 'plugin-host-entry.ts')],
    outfile: hostEntryPath,
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    sourcemap: false,
    logLevel: 'silent'
  })
}, 30_000)

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()))
  await Promise.all(pluginRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

afterAll(async () => {
  if (bundleRoot) {
    await rm(bundleRoot, { recursive: true, force: true })
  }
})

async function createPluginSpec(
  source = `export default function activate(orca) { orca.commands.register('run', async () => ({ ok: true })); }`
): Promise<PluginWorkerSpawnSpec> {
  const rootDir = await mkdtemp(join(tmpdir(), 'orca-plugin-supervision-'))
  pluginRoots.push(rootDir)
  await writeFile(join(rootDir, 'main.mjs'), source)
  return {
    pluginKey: 'samples.supervision',
    rootDir,
    mainEntry: 'main.mjs',
    grantedCapabilities: []
  }
}

describe('real plugin worker supervision', () => {
  it('terminates and supervises a live worker that disconnects IPC', async () => {
    const spec = await createPluginSpec(`
      export default function activate(orca) {
        orca.commands.register('disconnect', async () => {
          process.removeAllListeners('disconnect')
          setInterval(() => {}, 1_000)
          process.disconnect?.()
          await new Promise(() => {})
        })
      }
    `)
    const notifications = createStateNotifications()
    const manager = new PluginWorkerManager({
      entryPath: hostEntryPath,
      executeHostCall: async () => ({ ok: true, value: null }),
      log: () => vi.fn(),
      onWorkerStateChange: notifications.notify
    })
    managers.push(manager)

    const worker = await manager.ensureActive(spec)
    const command = worker.invokeCommand('disconnect')

    await expect(command).rejects.toThrow('disconnected')
    await notifications.waitFor(
      () => manager.runState(spec.pluginKey) === 'restarting',
      'disconnected worker to enter supervised backoff'
    )
    expect(manager.restartCount(spec.pluginKey)).toBe(1)
  })
})

describe('real plugin worker binary answers', () => {
  it('gives plugin.requestBytes the range of a typed array and keeps an oversized answer', async () => {
    // `memory` stands for WASM memory: the handler returns a view of 4 of its 64 bytes.
    const spec = await createPluginSpec(`
      export default function activate(orca) {
        const memory = Uint8Array.from({ length: 64 }, (_, index) => index)
        orca.panels.handle('signal.read', () => memory.subarray(16, 20))
        orca.panels.handle('signal.all', () => new Uint8Array(2 * 1024 * 1024 + 1))
      }
    `)
    const manager = new PluginWorkerManager({
      entryPath: hostEntryPath,
      executeHostCall: async () => ({ ok: true, value: null }),
      log: () => vi.fn(),
      onWorkerStateChange: () => undefined
    })
    managers.push(manager)
    const panel = { id: 'panel-a', surface: 'editor' as const, contributionId: 'waves' }
    const bridge = new PluginPanelBridge({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bridge reads only `manifest.main`.
      findApprovedPlugin: () => ({ manifest: { main: spec.mainEntry } }) as ValidDiscoveredPlugin,
      grantedCapabilities: () => [],
      ensureWorker: () => manager.ensureActive(spec),
      runningWorker: () => null,
      log: () => vi.fn()
    })

    const bytes = await bridge.requestBytes({
      pluginKey: spec.pluginKey,
      caller: panel,
      name: 'signal.read',
      input: null
    })
    expect([...new Uint8Array(bytes)]).toEqual([16, 17, 18, 19])

    // Asked below the bridge: the worker process itself refuses, so the bytes never reach main.
    const worker = await manager.ensureActive(spec)
    await expect(
      worker.requestFromPanel({ name: 'signal.all', input: null, panel, timeoutMs: 10_000 })
    ).rejects.toMatchObject({ code: 'too_large' })
  })
})
