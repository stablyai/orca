import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hashPluginTree } from './plugin-content-hash'
import { readPluginLockfile } from './plugin-install'
import { bootstrapBundledPlugins, resolveBundledPluginRoot } from './plugin-bundled-bootstrap'

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
  it('installs release-indexed content once and keeps unchanged startup work bounded', async () => {
    const root = await tempRoot('orca-bundled-resources-')
    const userDataPath = await tempRoot('orca-bundled-user-data-')
    const bundle = await writeBundle(root)
    await writeIndex(root, bundle.path, bundle.hash)

    await expect(
      bootstrapBundledPlugins({ root, userDataPath, hostVersion: '1.4.0' })
    ).resolves.toEqual({ installed: ['stablyai.orca-skills'], unchanged: [], errors: [] })
    await expect(
      bootstrapBundledPlugins({ root, userDataPath, hostVersion: '1.4.0' })
    ).resolves.toEqual({ installed: [], unchanged: ['stablyai.orca-skills'], errors: [] })
  })

  it('publishes an updated immutable bundle only when the indexed hash matches', async () => {
    const root = await tempRoot('orca-bundled-resources-')
    const userDataPath = await tempRoot('orca-bundled-user-data-')
    const first = await writeBundle(root)
    await writeIndex(root, first.path, first.hash)
    await bootstrapBundledPlugins({ root, userDataPath, hostVersion: '1.4.0' })
    const second = await writeBundle(root, 'Updated Skills')
    await writeIndex(root, second.path, second.hash)

    const updated = await bootstrapBundledPlugins({ root, userDataPath, hostVersion: '1.4.0' })

    expect(updated).toEqual({ installed: ['stablyai.orca-skills'], unchanged: [], errors: [] })
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
    ).resolves.toEqual({ installed: ['stablyai.orca-skills'], unchanged: [], errors: [] })

    await rm(versionDir, { recursive: true, force: true })
    await expect(
      bootstrapBundledPlugins({ root, userDataPath, hostVersion: '1.4.0' })
    ).resolves.toEqual({ installed: ['stablyai.orca-skills'], unchanged: [], errors: [] })
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

  it('resolves packaged and development resource roots without platform separators', () => {
    expect(
      resolveBundledPluginRoot({
        isPackaged: true,
        resourcesPath: join('app', 'resources'),
        appPath: join('repo', 'app')
      })
    ).toBe(join('app', 'resources', 'plugins', 'launch'))
    expect(
      resolveBundledPluginRoot({
        isPackaged: false,
        resourcesPath: join('app', 'resources'),
        appPath: join('repo', 'app')
      })
    ).toBe(join('repo', 'app', 'resources', 'plugins', 'launch'))
  })
})
