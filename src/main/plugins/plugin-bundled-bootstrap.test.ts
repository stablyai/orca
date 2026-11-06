import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hashPluginTree } from './plugin-content-hash'
import { installPluginFromLocalPath, readPluginLockfile } from './installation/plugin-install'
import { bootstrapBundledPlugins } from './plugin-bundled-bootstrap'
import { installStagedPluginTree } from './installation/plugin-install-staging'
import { OFFICIAL_MARKETPLACE_GIT_SOURCE } from '../../shared/plugins/catalog/plugin-marketplace'

const roots: string[] = []

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

async function writeBundle(root: string, name = 'Skills'): Promise<{ path: string; hash: string }> {
  const path = 'stablyai.orca-skills'
  const pluginRoot = join(root, path)
  await mkdir(pluginRoot, { recursive: true })
  await writeFile(
    join(pluginRoot, 'orca-plugin.json'),
    JSON.stringify({
      manifestVersion: 1,
      id: 'orca-skills',
      publisher: 'stablyai',
      name,
      version: '1.0.0',
      engines: { orca: '>=1.0.0' },
      pluginApi: 1,
      capabilities: []
    })
  )
  const hashed = await hashPluginTree(pluginRoot)
  if (!hashed.ok) {
    throw new Error(hashed.error)
  }
  return { path, hash: hashed.hash }
}

async function writeIndex(root: string, path: string, contentHash: string): Promise<void> {
  await writeFile(
    join(root, 'bundled-plugins.json'),
    JSON.stringify({
      version: 1,
      plugins: [{ pluginKey: 'stablyai.orca-skills', path, contentHash }]
    })
  )
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('bundled plugin bootstrap', () => {
  it('publishes an updated immutable bundle only when the indexed hash matches', async () => {
    const root = await tempRoot('orca-bundled-resources-')
    const userDataPath = await tempRoot('orca-bundled-user-data-')
    const first = await writeBundle(root)
    await writeIndex(root, first.path, first.hash)
    await bootstrapBundledPlugins({ root, userDataPath, hostVersion: '1.4.0' })
    const second = await writeBundle(root, 'Updated Skills')
    await writeIndex(root, second.path, second.hash)

    const updated = await bootstrapBundledPlugins({ root, userDataPath, hostVersion: '1.4.0' })

    expect(updated).toEqual({
      installed: ['stablyai.orca-skills'],
      unchanged: [],
      retired: [],
      errors: []
    })
    const lock = await readPluginLockfile(join(userDataPath, 'plugins'))
    expect(lock.plugins['stablyai.orca-skills']?.contentHash).toBe(second.hash)
  })

  it('repairs a missing or modified bundled current version', async () => {
    const root = await tempRoot('orca-bundled-resources-')
    const userDataPath = await tempRoot('orca-bundled-user-data-')
    const bundle = await writeBundle(root)
    await writeIndex(root, bundle.path, bundle.hash)
    await bootstrapBundledPlugins({ root, userDataPath, hostVersion: '1.4.0' })
    const versionDir = join(userDataPath, 'plugins', 'stablyai.orca-skills', bundle.hash)
    await writeFile(join(versionDir, 'orca-plugin.json'), '{}')

    await expect(
      bootstrapBundledPlugins({ root, userDataPath, hostVersion: '1.4.0' })
    ).resolves.toEqual({
      installed: ['stablyai.orca-skills'],
      unchanged: [],
      retired: [],
      errors: []
    })

    await rm(versionDir, { recursive: true, force: true })
    await expect(
      bootstrapBundledPlugins({ root, userDataPath, hostVersion: '1.4.0' })
    ).resolves.toEqual({
      installed: ['stablyai.orca-skills'],
      unchanged: [],
      retired: [],
      errors: []
    })
  })

  it('uninstalls a previously bundled plugin once a release stops shipping it', async () => {
    const root = await tempRoot('orca-bundled-resources-')
    const userDataPath = await tempRoot('orca-bundled-user-data-')
    const bundle = await writeBundle(root)
    await writeIndex(root, bundle.path, bundle.hash)
    await bootstrapBundledPlugins({ root, userDataPath, hostVersion: '1.4.0' })
    const dataDir = join(userDataPath, 'plugins-data', 'stablyai.orca-skills')
    await mkdir(dataDir, { recursive: true })
    await writeFile(join(root, 'bundled-plugins.json'), JSON.stringify({ version: 1, plugins: [] }))
    const events: string[] = []
    const pluginDir = join(userDataPath, 'plugins', 'stablyai.orca-skills')
    const beforeRetire = async (pluginKey: string): Promise<void> => {
      await access(pluginDir)
      events.push(`before:${pluginKey}`)
    }
    const afterRetire = async (pluginKey: string): Promise<void> => {
      await expect(access(pluginDir)).rejects.toThrow()
      events.push(`after:${pluginKey}`)
    }

    await expect(
      bootstrapBundledPlugins({
        root,
        userDataPath,
        hostVersion: '1.4.0',
        beforeRetire,
        afterRetire
      })
    ).resolves.toEqual({
      installed: [],
      unchanged: [],
      retired: ['stablyai.orca-skills'],
      errors: []
    })
    expect(events).toEqual(['before:stablyai.orca-skills', 'after:stablyai.orca-skills'])
    expect((await readPluginLockfile(join(userDataPath, 'plugins'))).plugins).toEqual({})
    await expect(access(join(userDataPath, 'plugins', 'stablyai.orca-skills'))).rejects.toThrow()
    await expect(access(dataDir)).rejects.toThrow()
    await expect(
      bootstrapBundledPlugins({ root, userDataPath, hostVersion: '1.4.0' })
    ).resolves.toEqual({ installed: [], unchanged: [], retired: [], errors: [] })
  })

  it('leaves plugins the user installed alone', async () => {
    const root = await tempRoot('orca-bundled-resources-')
    const userDataPath = await tempRoot('orca-bundled-user-data-')
    const sourcePath = join(root, 'local-plugin')
    await mkdir(sourcePath, { recursive: true })
    await writeFile(
      join(sourcePath, 'orca-plugin.json'),
      JSON.stringify({
        manifestVersion: 1,
        id: 'local-plugin',
        publisher: 'someone',
        name: 'Local Plugin',
        version: '1.0.0',
        engines: { orca: '>=1.0.0' },
        pluginApi: 1,
        capabilities: []
      })
    )
    await writeFile(join(root, 'bundled-plugins.json'), JSON.stringify({ version: 1, plugins: [] }))
    const installed = await installPluginFromLocalPath({
      pluginsDir: join(userDataPath, 'plugins'),
      sourcePath,
      hostVersion: '1.4.0'
    })
    expect(installed).toMatchObject({ ok: true })

    await expect(
      bootstrapBundledPlugins({ root, userDataPath, hostVersion: '1.4.0' })
    ).resolves.toEqual({ installed: [], unchanged: [], retired: [], errors: [] })
    const lock = await readPluginLockfile(join(userDataPath, 'plugins'))
    expect(lock.plugins['someone.local-plugin']?.source.kind).toBe('local-path')
  })

  it('never replaces a catalog install of a bundled plugin with the shipped bytes', async () => {
    const root = await tempRoot('orca-bundled-resources-')
    const catalogRoot = await tempRoot('orca-bundled-catalog-')
    const userDataPath = await tempRoot('orca-bundled-user-data-')
    const pluginsDir = join(userDataPath, 'plugins')
    const shipped = await writeBundle(root)
    await writeIndex(root, shipped.path, shipped.hash)
    await bootstrapBundledPlugins({ root, userDataPath, hostVersion: '1.4.0' })
    const catalog = await writeBundle(catalogRoot, 'Newer Skills')
    const updated = await installStagedPluginTree({
      pluginsDir,
      stagingDir: join(catalogRoot, catalog.path),
      hostVersion: '1.4.0',
      source: {
        kind: 'marketplace',
        marketplace: { ...OFFICIAL_MARKETPLACE_GIT_SOURCE, resolvedCommit: 'a'.repeat(40) },
        plugin: { url: OFFICIAL_MARKETPLACE_GIT_SOURCE.url, ref: 'main' }
      },
      resolvedCommit: 'a'.repeat(40),
      identity: { pluginKey: 'stablyai.orca-skills' }
    })
    expect(updated).toMatchObject({ ok: true })

    await expect(
      bootstrapBundledPlugins({ root, userDataPath, hostVersion: '1.4.0' })
    ).resolves.toEqual({ installed: [], unchanged: [], retired: [], errors: [] })
    const lock = await readPluginLockfile(pluginsDir)
    expect(lock.plugins['stablyai.orca-skills']).toMatchObject({
      contentHash: catalog.hash,
      source: { kind: 'marketplace' }
    })
  })

  it('refuses mismatched release hashes before publication', async () => {
    const root = await tempRoot('orca-bundled-resources-')
    const userDataPath = await tempRoot('orca-bundled-user-data-')
    const bundle = await writeBundle(root)
    await writeIndex(root, bundle.path, 'f'.repeat(64))

    const result = await bootstrapBundledPlugins({ root, userDataPath, hostVersion: '1.4.0' })

    expect(result.installed).toEqual([])
    expect(result.errors[0]?.error).toContain('does not match its release index')
    expect((await readPluginLockfile(join(userDataPath, 'plugins'))).plugins).toEqual({})
  })
})
