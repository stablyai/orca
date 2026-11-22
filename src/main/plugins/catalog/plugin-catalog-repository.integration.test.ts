import { randomFillSync } from 'node:crypto'
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { PluginMarketplace } from '../../../shared/plugins/catalog/plugin-marketplace'
import { pluginShaImageUrl } from '../../../shared/plugins/images/plugin-image-url'
import { serveRepositoriesOverTestSsh } from '../__mocks__/plugin-git-ssh-remote-fixture'
import { runPluginGit } from '../installation/plugin-git-repository'
import * as pluginGit from '../installation/plugin-git-repository'
import { PluginCatalogImageOnDemand } from '../media/plugin-catalog-image-on-demand'
import { PluginImageCache } from '../media/plugin-image-cache'
import { createPluginImageRequestHandler } from '../media/plugin-image-protocol'
import { catalogImageFixture, pngImageBytes } from '../media/plugin-image-test-fixture'
import { PluginCatalogRepositoryStore } from './plugin-catalog-repository'
import * as catalogBlobs from './plugin-catalog-blob-reader'
import * as retainedGit from './plugin-catalog-git-repository'
import { PluginMarketplaceService } from './plugin-marketplace-service'
import { PluginMarketplaceStore } from './plugin-marketplace-store'
import { snapshotRepositorySlot } from './plugin-marketplace-store'

vi.mock('electron', () => ({ protocol: { handle: vi.fn() } }))

const roots: string[] = []
const runUnmockedGit = runPluginGit
const runUnmockedDownload = pluginGit.runBoundedPluginGitDownload

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture({
  largeCatalog = false,
  maxDownloadBytes,
  collision = false
}: {
  largeCatalog?: boolean
  maxDownloadBytes?: number
  collision?: boolean
} = {}) {
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
  if (collision) {
    await publish('tag.png', pngImageBytes(1280, 800))
    await git(['tag', 'main'])
  }
  const firstCommit = await publish('first.png', firstBytes)
  const store = new PluginMarketplaceStore(root)
  const repositories = new PluginCatalogRepositoryStore(root, maxDownloadBytes)
  const service = new PluginMarketplaceService({ pluginsDataDir: root, store, repositories })
  const source = await service.addSource({
    kind: 'git',
    url: 'ssh://git@example.invalid/catalog.git',
    ref: 'main'
  })
  const repository = join(root, 'catalog-repositories', source.id, 'repository')
  const read = async (commit: string, path: string) => {
    const slot = snapshotRepositorySlot(await store.readSnapshot(source.id))
    return (
      await repositories.readImages(
        source.id,
        commit,
        new Map([[path, 1024 * 1024]]),
        undefined,
        slot
      )
    ).get(path)
  }
  return {
    root,
    git,
    firstBytes,
    iconBytes,
    firstCommit,
    publish,
    read,
    repository,
    repositories,
    service,
    source,
    store
  }
}

// Git writes and compresses 65 MiB of fixture artwork, which is slower on shared runners.
it('retains the late-alphabet cover and icon in a catalog over 64 MiB of artwork', async () => {
  const f = await fixture({ largeCatalog: true })
  const snapshot = await f.store.readSnapshot(f.source.id)
  const entry = snapshot?.marketplace.plugins.find((plugin) => plugin.id === 'acme.zebra')

  expect(entry && 'releases' in entry ? entry.releases?.[0]?.images : undefined).toMatchObject({
    cover: { path: 'first.png' },
    icon: { path: 'zebra-icon.png' }
  })
  const cache = new PluginImageCache(join(f.root, 'images'))
  const resolver = new PluginCatalogImageOnDemand({
    cache,
    store: f.store,
    repositories: f.repositories
  })
  const handler = createPluginImageRequestHandler({
    cache,
    readCatalogImage: (reference, signal) => resolver.read(reference, signal),
    findValidPlugin: () => null,
    findApprovedPlugin: () => null
  })
  for (const [kind, path, bytes] of [
    ['cover', 'first.png', f.firstBytes],
    ['icon', 'zebra-icon.png', f.iconBytes]
  ] as const) {
    const image = catalogImageFixture(path, bytes)
    const url = pluginShaImageUrl(
      image.sha256,
      { ...image, kind },
      {
        sourceId: f.source.id,
        commit: f.firstCommit,
        path,
        fetchedAt: snapshot!.fetchedAt
      }
    )
    const response = await handler(new Request(url))
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
  }
}, 120_000)

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

it('rolls back rejected downloads and charges only new object bytes', async () => {
  const f = await fixture({ maxDownloadBytes: 24 * 1024 })
  const pack = join(f.repository, '.git', 'objects', 'pack')
  const inventoryBefore = (await readdir(pack)).sort()
  vi.spyOn(pluginGit, 'runBoundedPluginGitDownload').mockImplementationOnce(async () => {
    await writeFile(join(pack, 'tmp_obj_aborted'), 'partial pack')
    throw new Error('download aborted')
  })
  expect(await f.service.refreshSource(f.source.id)).toMatchObject({
    stale: true,
    error: 'download aborted'
  })
  expect((await readdir(pack)).sort()).toEqual(inventoryBefore)

  const oversized = pngImageBytes(1280, 800, 40 * 1024)
  randomFillSync(oversized, 45)
  await f.publish('oversized.png', oversized)
  expect(await f.service.refreshSource(f.source.id)).toMatchObject({
    stale: true,
    error: expect.stringContaining('download size limit')
  })
  expect((await readdir(pack)).sort()).toEqual(inventoryBefore)
  expect(await f.read(f.firstCommit, 'first.png')).toEqual(f.firstBytes)

  await f.git(['rm', 'oversized.png'])
  const admissible = pngImageBytes(1280, 800, 20 * 1024)
  randomFillSync(admissible, 45)
  const next = await f.publish('admissible.png', admissible)
  vi.spyOn(f.store, 'writeSnapshot').mockRejectedValueOnce(new Error('snapshot write failed'))
  expect(await f.service.refreshSource(f.source.id)).toMatchObject({
    stale: true,
    error: 'snapshot write failed'
  })
  expect((await readdir(pack)).sort()).toEqual(inventoryBefore)
  expect(await f.service.refreshSource(f.source.id)).toMatchObject({ stale: false })
  expect(await f.read(next, 'admissible.png')).toEqual(admissible)

  await f.git(['rm', 'admissible.png'])
  const following = pngImageBytes(1280, 800, 20 * 1024)
  randomFillSync(following, 45)
  const followingCommit = await f.publish('following.png', following)
  expect(await f.service.refreshSource(f.source.id)).toMatchObject({ stale: false })
  expect(await f.read(followingCommit, 'following.png')).toEqual(following)
})

it('keeps readable art from a damaged repository on save failure and switches slots after save', async () => {
  const f = await fixture()
  const broken = join(f.repository, '.git', 'objects', 'de', 'ad'.repeat(19))
  await mkdir(join(broken, '..'))
  await writeFile(broken, 'not a Git object')
  const candidate = await f.publish('second.png', pngImageBytes(1280, 800))
  vi.spyOn(f.store, 'writeSnapshot').mockRejectedValueOnce(new Error('snapshot write failed'))

  expect(await f.service.refreshSource(f.source.id)).toMatchObject({ stale: true })
  expect(await f.read(f.firstCommit, 'first.png')).toEqual(f.firstBytes)
  await expect(access(broken)).resolves.toBeUndefined()

  expect(await f.service.refreshSource(f.source.id)).toMatchObject({ stale: false })
  const snapshot = await new PluginMarketplaceStore(f.root).readSnapshot(f.source.id)
  expect(snapshot).toMatchObject({ marketplaceCommit: candidate, catalogRepository: 'replacement' })
  await expect(access(f.repository)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('can read the published image while an integrity check is pending', async () => {
  const f = await fixture()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  vi.spyOn(pluginGit, 'runPluginGit').mockImplementation(async (args, cwd, signal) => {
    if (args.includes('fsck')) {
      started.resolve()
      await release.promise
    }
    return runUnmockedGit(args, cwd, signal)
  })
  const refreshing = f.service.refreshSource(f.source.id)
  await started.promise
  const readImages = vi.spyOn(catalogBlobs, 'readCatalogImageBlobs')
  const reading = f.read(f.firstCommit, 'first.png')
  try {
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(readImages).toHaveBeenCalled()
  } finally {
    release.resolve()
    await Promise.all([refreshing, reading])
  }
  expect(await reading).toEqual(f.firstBytes)
})

it('holds the previous Git objects until an active reader releases them', async () => {
  const f = await fixture()
  const next = await f.publish('second.png', pngImageBytes(1280, 800))
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<Map<string, Buffer>>()
  vi.spyOn(catalogBlobs, 'readCatalogImageBlobs').mockImplementationOnce(async () => {
    started.resolve()
    return release.promise
  })
  const reading = f.read(f.firstCommit, 'first.png')
  await started.promise
  const saved = Promise.withResolvers<void>()
  const write = f.store.writeSnapshot.bind(f.store)
  vi.spyOn(f.store, 'writeSnapshot').mockImplementationOnce(async (input) => {
    const snapshot = await write(input)
    saved.resolve()
    return snapshot
  })
  const pin = vi.spyOn(retainedGit, 'pinRetainedPluginGitCommit')
  const refreshing = f.service.refreshSource(f.source.id)
  try {
    await saved.promise
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(pin).not.toHaveBeenCalledWith(f.repository, next)
  } finally {
    release.resolve(new Map([['first.png', f.firstBytes]]))
    await Promise.all([reading, refreshing])
  }
  expect(await reading).toEqual(f.firstBytes)
  expect(pin).toHaveBeenCalledWith(f.repository, next)
})

it('fetches the branch on both first and subsequent reads when a tag shares its name', async () => {
  const f = await fixture({ collision: true })
  expect((await f.store.readSnapshot(f.source.id))?.marketplaceCommit).toBe(f.firstCommit)
  const updated = await f.publish('second.png', pngImageBytes(1280, 800))
  expect(await f.service.refreshSource(f.source.id)).toMatchObject({
    marketplace: { resolvedCommit: updated }
  })
})

it('pins the published commit before contacting the remote', async () => {
  const f = await fixture()
  await runPluginGit(['update-ref', '-d', 'refs/orca/snapshot'], f.repository)
  vi.spyOn(pluginGit, 'runBoundedPluginGitDownload').mockImplementation(async (...args) => {
    expect(await runUnmockedGit(['rev-parse', '--verify', 'refs/orca/snapshot'], args[1])).toBe(
      f.firstCommit
    )
    return runUnmockedDownload(...args)
  })
  expect(await f.service.refreshSource(f.source.id)).toMatchObject({ stale: false })
})

it('sweeps abandoned repositories at startup and retries a failed removal', async () => {
  const f = await fixture()
  vi.spyOn(f.repositories, 'remove').mockRejectedValueOnce(new Error('remove failed'))
  await expect(f.service.removeSource(f.source.id)).rejects.toThrow('remove failed')
  await expect(access(f.repository)).resolves.toBeUndefined()
  await expect(f.service.removeSource(f.source.id)).resolves.toBe(false)
  await expect(access(f.repository)).rejects.toMatchObject({ code: 'ENOENT' })

  await mkdir(f.repository, { recursive: true })
  const restarted = new PluginMarketplaceService({ pluginsDataDir: f.root })
  await expect(restarted.removeSource('f'.repeat(32))).resolves.toBe(false)
  await expect(access(f.repository)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await restarted.listSources()).toEqual([])
})
