import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { emptyPluginLockfile } from '../../shared/plugins/installation/plugin-install-lockfile'
import { pluginManifestSchema } from '../../shared/plugins/manifest/plugin-manifest'
import type { InvalidDiscoveredPlugin, ValidDiscoveredPlugin } from './plugin-discovery'
import { buildPluginList } from './plugin-list-projection'
import type { PluginService } from './plugin-service'

// Why spy on every fs entry point: the list is rebuilt on every plugin change and at startup,
// so it must stay pure projection; per-plugin reads belong behind on-demand IPC.
const fsCalls = vi.hoisted(() => ({ count: 0 }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  const counted =
    <Args extends unknown[], Result>(fn: (...args: Args) => Result) =>
    (...args: Args): Result => {
      fsCalls.count += 1
      return fn(...args)
    }
  return {
    ...actual,
    readdir: counted(actual.readdir),
    readFile: counted(actual.readFile),
    stat: counted(actual.stat),
    lstat: counted(actual.lstat),
    open: counted(actual.open),
    opendir: counted(actual.opendir)
  }
})

const manifest = pluginManifestSchema.parse({
  manifestVersion: 1,
  id: 'demo',
  publisher: 'samples',
  name: 'Demo',
  version: '1.0.0',
  engines: { orca: '>=1.0.0' },
  pluginApi: 1,
  contributes: { panels: [], commands: [], events: [] },
  capabilities: [{ kind: 'workspace:read' }]
})

function serviceWith(
  discovered: ValidDiscoveredPlugin,
  options: {
    activation?: ReturnType<PluginService['activationState']>
    worker?: ReturnType<PluginService['workerState']>
    vmRecipes?: ReturnType<PluginService['contentPacks']['vmRecipes']['preview']>
    commands?: ReturnType<PluginService['contentPacks']['commands']['preview']>
  } = {}
): PluginService {
  return {
    options: {
      getPluginConsents: () => ({}),
      getDisabledPlugins: () => []
    },
    getDiscovered: () => [discovered],
    activationState: () => options.activation ?? 'pending',
    workerState: () => options.worker ?? { state: 'inactive', restarts: 0 },
    activationError: () => null,
    contentPacks: {
      vmRecipes: { preview: () => options.vmRecipes ?? [] },
      commands: { preview: () => options.commands ?? [] }
    }
  } as unknown as PluginService
}

describe('buildPluginList consent identity', () => {
  it('does not attribute a shadowing dev plugin to the installed source', async () => {
    const plugin: ValidDiscoveredPlugin = {
      pluginKey: 'samples.demo',
      rootDir: join(tmpdir(), 'development', 'demo'),
      manifest,
      consentFingerprint: 'sha256-current',
      contentHash: null,
      isDev: true
    }
    const lock = {
      version: 1 as const,
      plugins: {
        [plugin.pluginKey]: {
          pluginKey: plugin.pluginKey,
          version: '1.0.0',
          source: { kind: 'git' as const, url: 'https://example.com/demo.git', ref: 'v1' },
          resolvedCommit: 'a'.repeat(40),
          contentHash: 'b'.repeat(64),
          consentFingerprint: 'sha256-installed',
          installedAt: 1
        }
      }
    }

    expect((await buildPluginList(serviceWith(plugin), lock))[0]).not.toHaveProperty('source')
  })

  it('does not expose an invalid development plugin absolute path as identity', async () => {
    const invalid: InvalidDiscoveredPlugin = {
      rootDir: join(tmpdir(), 'private', 'secret-plugin-path'),
      error: 'missing orca-plugin.json',
      isDev: true
    }
    const service = {
      options: { getPluginConsents: () => ({}), getDisabledPlugins: () => [] },
      getDiscovered: () => [invalid]
    } as unknown as PluginService

    const projected = (await buildPluginList(service, emptyPluginLockfile()))[0]!
    expect(projected.pluginKey).toBe('invalid-development-plugin-1')
    expect(projected.name).toBe('invalid-development-plugin-1')
    expect(JSON.stringify(projected)).not.toContain(invalid.rootDir)
  })
})

describe('buildPluginList I/O', () => {
  it('builds the list for installed plugins without reading the plugin directories', async () => {
    const plugin: ValidDiscoveredPlugin = {
      pluginKey: 'samples.demo',
      rootDir: join(tmpdir(), 'plugins', 'samples.demo', 'a'.repeat(64)),
      manifest,
      consentFingerprint: 'sha256-current',
      contentHash: 'a'.repeat(64),
      isDev: false
    }
    const lock = emptyPluginLockfile()
    lock.plugins[plugin.pluginKey] = {
      pluginKey: plugin.pluginKey,
      version: '1.0.0',
      source: { kind: 'git', url: 'https://github.com/samples/demo.git', ref: 'main' },
      resolvedCommit: 'c'.repeat(40),
      contentHash: 'a'.repeat(64),
      consentFingerprint: 'sha256-current',
      installedAt: 1
    }
    fsCalls.count = 0

    const [entry] = await buildPluginList(serviceWith(plugin), lock)

    expect(entry?.source?.kind).toBe('git')
    expect(fsCalls.count).toBe(0)
  })
})
