import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PluginInstallSource } from '../../../shared/plugins/installation/plugin-install-lockfile'
import { splitQualifiedPluginKey } from '../../../shared/plugins/catalog/plugin-marketplace'
import { pluginCatalogTakeoverError } from './plugin-catalog-install-guard'
import { installPluginFromLocalPath, readPluginLockfile } from './plugin-install'
import { writePluginLockfile } from './plugin-install-lockfile-store'
import { installStagedPluginTree } from './plugin-install-staging'
import { writePluginInstallProvenance } from './plugin-install-provenance'

const roots: string[] = []
const catalog = {
  url: 'https://example.com/catalog.git',
  ref: 'main',
  resolvedCommit: 'a'.repeat(40)
}
const marketplaceSource: PluginInstallSource = {
  kind: 'marketplace',
  marketplace: catalog,
  plugin: { url: 'https://example.com/demo.git', ref: 'main' }
}

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

async function writePluginSource(root: string): Promise<void> {
  await writeFile(
    join(root, 'orca-plugin.json'),
    JSON.stringify({
      manifestVersion: 1,
      id: 'demo',
      publisher: 'samples',
      name: 'Demo',
      version: '1.0.0',
      engines: { orca: '>=1.0.0' },
      pluginApi: 1,
      contributes: { panels: [], commands: [], events: [] },
      capabilities: []
    })
  )
}

/** Installs locally, then rewrites the lock so the install looks like it came from a catalog. */
async function catalogInstall(): Promise<{ pluginsDir: string; sourcePath: string; key: string }> {
  const sourcePath = await tempRoot('orca-plugin-source-')
  const pluginsDir = await tempRoot('orca-plugin-installs-')
  await writePluginSource(sourcePath)
  const first = await installPluginFromLocalPath({ pluginsDir, sourcePath, hostVersion: '1.4.0' })
  if (!first.ok) {
    throw new Error(first.error)
  }
  const lock = await readPluginLockfile(pluginsDir)
  const entry = lock.plugins[first.pluginKey]
  if (!entry) {
    throw new Error('missing lock entry')
  }
  const catalogEntry = { ...entry, source: marketplaceSource }
  // Why both: lock reads repair the entry from the current version's provenance.
  await writePluginInstallProvenance(join(pluginsDir, first.pluginKey), catalogEntry)
  lock.plugins[first.pluginKey] = catalogEntry
  await writePluginLockfile(pluginsDir, lock)
  return { pluginsDir, sourcePath, key: first.pluginKey }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('pluginCatalogTakeoverError', () => {
  it('allows sources that are not catalog installs and the same catalog', () => {
    expect(pluginCatalogTakeoverError('p.demo', undefined, null)).toBeNull()
    expect(
      pluginCatalogTakeoverError('p.demo', { kind: 'local-path', path: '/tmp/demo' }, null)
    ).toBeNull()
    expect(pluginCatalogTakeoverError('p.demo', marketplaceSource, catalog)).toBeNull()
  })

  it('refuses another catalog, another ref, and direct sources', () => {
    const otherCatalog =
      'p.demo is installed from https://example.com/catalog.git; remove it first to install it from another catalog'
    expect(
      pluginCatalogTakeoverError('p.demo', marketplaceSource, {
        url: 'https://example.com/other.git',
        ref: 'main'
      })
    ).toBe(otherCatalog)
    expect(
      pluginCatalogTakeoverError('p.demo', marketplaceSource, { url: catalog.url, ref: 'next' })
    ).toBe(otherCatalog)
    expect(pluginCatalogTakeoverError('p.demo', marketplaceSource, null)).toBe(
      'p.demo is installed from https://example.com/catalog.git; remove it first to install it from a Git URL or local folder'
    )
  })
})

describe('direct installs over a catalog install', () => {
  it('refuses a local folder and keeps the catalog lock source', async () => {
    const { pluginsDir, sourcePath, key } = await catalogInstall()

    const result = await installPluginFromLocalPath({
      pluginsDir,
      sourcePath,
      hostVersion: '1.4.0'
    })

    expect(result).toEqual({
      ok: false,
      error: `${key} is installed from ${catalog.url}; remove it first to install it from a Git URL or local folder`
    })
    expect((await readPluginLockfile(pluginsDir)).plugins[key]?.source).toEqual(marketplaceSource)
  })

  it('refuses a Git source that resolves to the same key', async () => {
    const { pluginsDir, sourcePath, key } = await catalogInstall()

    const result = await installStagedPluginTree({
      pluginsDir,
      stagingDir: sourcePath,
      hostVersion: '1.4.0',
      source: { kind: 'git', url: 'https://example.com/fork.git', ref: '' },
      resolvedCommit: 'b'.repeat(40),
      identity: { publisher: splitQualifiedPluginKey(key)?.publisher ?? '' }
    })

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('remove it first') })
    expect((await readPluginLockfile(pluginsDir)).plugins[key]?.source).toEqual(marketplaceSource)
  })
})
