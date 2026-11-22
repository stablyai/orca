import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { PluginMarketplace } from '../../../shared/plugins/catalog/plugin-marketplace'
import { serveRepositoriesOverTestSsh } from '../__mocks__/plugin-git-ssh-remote-fixture'
import { runPluginGit } from '../installation/plugin-git-repository'
import { catalogImageFixture, pngImageBytes } from '../media/plugin-image-test-fixture'
import { PluginCatalogRepositoryStore } from './plugin-catalog-repository'
import { PluginMarketplaceService } from './plugin-marketplace-service'
import { PluginMarketplaceStore } from './plugin-marketplace-store'

const roots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(largeCatalog = false) {
  const root = await mkdtemp(join(tmpdir(), 'orca-retained-catalog-'))
  roots.push(root)
  const upstream = join(root, 'upstream')
  await mkdir(upstream)
  await serveRepositoriesOverTestSsh(root, { '/catalog.git': upstream })
  const git = (args: string[]) => runPluginGit(args, upstream)
  await git(['init', '--quiet'])
  await git(['checkout', '--quiet', '-b', 'main'])
  const entries: PluginMarketplace['plugins'] = []
  const entry = (
    id: string,
    images: NonNullable<PluginMarketplace['plugins'][number]['releases']>[number]['images']
  ): PluginMarketplace['plugins'][number] => ({
    id: `acme.${id}`,
    categories: ['language-packs'],
    source: { kind: 'git', url: `https://example.invalid/acme/${id}.git`, ref: 'main' },
    releases: [
      {
        version: '1.0.0',
        minimumOrca: '1.4.0',
        execution: 'data',
        commit: 'a'.repeat(40),
        contentHash: 'b'.repeat(64),
        types: ['interface-language'],
        images
      }
    ]
  })
  if (largeCatalog) {
    for (let index = 0; index < 65; index++) {
      const path = `early-${index}.png`
      const bytes = pngImageBytes(1600, 1000, 1024 * 1024, index)
      await writeFile(join(upstream, path), bytes)
      entries.push(entry(`early-${index}`, { cover: catalogImageFixture(path, bytes) }))
    }
  }
  const iconBytes = pngImageBytes(128, 128)
  const publish = async (file: string, bytes: Buffer) => {
    await writeFile(join(upstream, file), bytes)
    await writeFile(join(upstream, 'zebra-icon.png'), iconBytes)
    await writeFile(
      join(upstream, 'orca-catalog.json'),
      JSON.stringify({
        catalogVersion: 2,
        name: 'Test Catalog',
        owner: 'acme',
        plugins: [
          ...entries,
          entry('zebra', {
            cover: catalogImageFixture(file, bytes),
            icon: catalogImageFixture('zebra-icon.png', iconBytes)
          })
        ]
      })
    )
    await git(['add', '--all'])
    await git([
      '-c',
      'user.name=Catalog fixture',
      '-c',
      'user.email=catalog@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      `Publish ${file}`
    ])
    return git(['rev-parse', 'HEAD'])
  }
  const firstBytes = pngImageBytes(1600, 1000)
  const firstCommit = await publish('first.png', firstBytes)
  const store = new PluginMarketplaceStore(root)
  const repositories = new PluginCatalogRepositoryStore(root)
  const service = new PluginMarketplaceService({ pluginsDataDir: root, store, repositories })
  const source = await service.addSource({
    kind: 'git',
    url: 'ssh://git@example.invalid/catalog.git',
    ref: 'main'
  })
  const repository = join(root, 'catalog-repositories', source.id, 'repository')
  const read = async (commit: string, path: string) =>
    (await repositories.readImages(source.id, commit, new Map([[path, 1024 * 1024]]))).get(path)
  return { firstBytes, firstCommit, publish, read, repository, service, source, store }
}

it('retains the late-alphabet cover and icon in a catalog over 64 MiB of artwork', async () => {
  const f = await fixture(true)
  const snapshot = await f.store.readSnapshot(f.source.id)
  const entry = snapshot?.marketplace.plugins.find((plugin) => plugin.id === 'acme.zebra')

  expect(entry && 'releases' in entry ? entry.releases?.[0]?.images : undefined).toMatchObject({
    cover: { path: 'first.png' },
    icon: { path: 'zebra-icon.png' }
  })
}, 30_000)

it('keeps the published image readable until a replacement snapshot is saved', async () => {
  const f = await fixture()
  const secondBytes = pngImageBytes(1280, 800)
  const secondCommit = await f.publish('second.png', secondBytes)
  vi.spyOn(f.store, 'writeSnapshot').mockRejectedValueOnce(new Error('snapshot write failed'))

  expect(await f.service.refreshSource(f.source.id)).toMatchObject({ stale: true })
  expect((await f.store.readSnapshot(f.source.id))?.marketplaceCommit).toBe(f.firstCommit)
  expect(await f.read(f.firstCommit, 'first.png')).toEqual(f.firstBytes)

  expect(await f.service.refreshSource(f.source.id)).toMatchObject({ stale: false })
  expect((await f.store.readSnapshot(f.source.id))?.marketplaceCommit).toBe(secondCommit)
  expect(await f.read(secondCommit, 'second.png')).toEqual(secondBytes)
  await expect(
    runPluginGit(['cat-file', '-e', `${f.firstCommit}^{commit}`], f.repository)
  ).rejects.toThrow()
})

it('reclones a corrupt catalog and removes the retained repository when unregistered', async () => {
  const f = await fixture()
  await rm(join(f.repository, '.git', 'objects'), { recursive: true })

  expect(await f.service.refreshSource(f.source.id)).toMatchObject({ stale: false })
  expect(await f.read(f.firstCommit, 'first.png')).toEqual(f.firstBytes)

  expect(await f.service.removeSource(f.source.id)).toBe(true)
  await expect(access(f.repository)).rejects.toMatchObject({ code: 'ENOENT' })
})
