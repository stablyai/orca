import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { executePluginHostCall } from './plugin-host-methods'
import { bindPluginHostServices, type PluginRuntimeDelegate } from './plugin-host-service-bindings'
import { PluginWorkerManager, type PluginWorkerSpawnSpec } from './plugin-worker-manager'

const PLUGIN_KEY = 'local.dev-storage'
const roots: string[] = []
let hostEntryPath = ''

function unused(): never {
  throw new Error('not used by this test')
}

const delegate: PluginRuntimeDelegate = {
  resolveActiveWorktreeContext: unused,
  listTerminals: unused,
  sendTerminal: unused,
  dispatchPluginNotification: unused
}

function pidOf(result: unknown): unknown {
  return typeof result === 'object' && result !== null && 'pid' in result ? result.pid : null
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

beforeAll(async () => {
  hostEntryPath = join(await tempDir('orca-plugin-host-bundle-'), 'plugin-host-entry.cjs')
  await build({
    entryPoints: [join(process.cwd(), 'src', 'main', 'plugins', 'workers', 'plugin-host-entry.ts')],
    outfile: hostEntryPath,
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    logLevel: 'silent'
  })
}, 30_000)

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe('dev worker restarts', () => {
  // Spawns two real worker processes, which takes seconds on a loaded CI host.
  it('keep storage: a dev save starts a new worker process that reads what the last one wrote', async () => {
    const rootDir = await tempDir('orca-plugin-dev-worker-')
    const services = bindPluginHostServices({
      delegate,
      pluginsDataDir: await tempDir('orca-plugin-data-')
    })
    await writeFile(
      join(rootDir, 'main.mjs'),
      `export default function activate(orca) {
        orca.commands.register('run', async () => {
          const { value } = await orca.host.call('storage.get', { key: 'runs' })
          const runs = (value ?? 0) + 1
          await orca.host.call('storage.set', { key: 'runs', value: runs })
          return { runs, pid: process.pid }
        })
      }`
    )
    const manager = new PluginWorkerManager({
      entryPath: hostEntryPath,
      executeHostCall: (pluginId, method, params) =>
        executePluginHostCall({
          pluginId,
          method,
          params,
          surface: 'worker',
          grantedCapabilities: ['storage:own'],
          services,
          audit: { record: vi.fn() }
        }),
      log: () => vi.fn(),
      onWorkerStateChange: () => undefined
    })
    const spec = (devRevision: string): PluginWorkerSpawnSpec => ({
      pluginKey: PLUGIN_KEY,
      rootDir,
      mainEntry: 'main.mjs',
      devRevision,
      grantedCapabilities: ['storage:own']
    })
    try {
      const first = await (await manager.ensureActive(spec('dev-1'))).invokeCommand('run')
      // The dev watcher's next revision: a different spawn spec, so a fresh process.
      const second = await (await manager.ensureActive(spec('dev-2'))).invokeCommand('run')
      expect(first).toMatchObject({ runs: 1 })
      expect(second).toMatchObject({ runs: 2 })
      expect(pidOf(second)).not.toBe(pidOf(first))
    } finally {
      await manager.disposeAll()
    }
  }, 30_000)
})
