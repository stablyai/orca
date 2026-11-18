import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  PluginCatalogImages,
  PluginImageKind
} from '../../../shared/plugins/images/plugin-image-fields'
import { pluginShaImageUrl } from '../../../shared/plugins/images/plugin-image-url'
import { PluginMarketplaceStore } from '../catalog/plugin-marketplace-store'
import { PluginCatalogRepositoryStore } from '../catalog/plugin-catalog-repository'
import { gitExecFileAsyncBuffer } from '../../git/command-runner/git-exec-file'
import { PluginCatalogImageOnDemand } from './plugin-catalog-image-on-demand'
import { PluginImageCache } from './plugin-image-cache'
import { createPluginImageRequestHandler } from './plugin-image-protocol'
import { catalogImageFixture, pngImageBytes } from './plugin-image-test-fixture'

vi.mock('electron', () => ({ protocol: { handle: vi.fn() } }))
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function imageCatalog(
  options: {
    bytes?: Buffer
    kind?: PluginImageKind
    declared?: { sha256?: string; width?: number }
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'orca-catalog-image-'))
  roots.push(root)
  const bytes = options.bytes ?? pngImageBytes(1600, 1000)
  const image = { ...catalogImageFixture('cover.png', bytes), ...options.declared }
  const kind = options.kind ?? 'cover'
  const images: PluginCatalogImages = kind === 'icon' ? { icon: image } : { cover: image }
  const store = new PluginMarketplaceStore(root)
  const source = await store.addSource({
    kind: 'git',
    url: 'https://github.com/acme/catalog.git',
    ref: 'main'
  })
  const marketplace = {
    name: 'Catalog',
    owner: 'acme',
    plugins: [
      {
        id: 'acme.picture',
        categories: ['themes'],
        source: source.source,
        releases: [
          {
            version: '1.0.0',
            minimumOrca: '1.4.0',
            execution: 'data' as const,
            commit: 'a'.repeat(40),
            contentHash: 'b'.repeat(64),
            images
          }
        ]
      }
    ]
  }
  await store.writeSnapshot({ source, marketplaceCommit: 'c'.repeat(40), marketplace })
  const cache = new PluginImageCache(join(root, 'images'))
  const readImages = vi.fn(async () => new Map([[image.path, bytes]]))
  const resolver = new PluginCatalogImageOnDemand({ cache, store, repositories: { readImages } })
  const handler = createPluginImageRequestHandler({
    cache,
    ensureCatalogImage: (hash) => resolver.ensureCached(hash),
    findValidPlugin: () => null,
    findApprovedPlugin: () => null
  })
  return { root, bytes, image, cache, source, store, marketplace, resolver, handler, readImages }
}

const request = (hash: string) => new Request(pluginShaImageUrl(hash))

describe('on-demand catalog image protocol', () => {
  it('serves a cold image from the retained Git commit and caches it without network', async () => {
    const fixture = await imageCatalog()
    const repository = join(fixture.root, 'catalog-repositories', fixture.source.id, 'repository')
    await mkdir(repository, { recursive: true })
    await writeFile(join(repository, 'cover.png'), fixture.bytes)
    const git = (args: string[]) =>
      gitExecFileAsyncBuffer(args, { cwd: repository, timeout: 10_000 })
    await git(['init', '--quiet'])
    await git(['add', '.'])
    await git([
      '-c',
      'user.name=Catalog test',
      '-c',
      'user.email=catalog@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'image fixture'
    ])
    const commit = (await git(['rev-parse', 'HEAD'])).stdout.toString().trim()
    await fixture.store.writeSnapshot({
      source: fixture.source,
      marketplaceCommit: commit,
      marketplace: fixture.marketplace
    })
    const repositories = new PluginCatalogRepositoryStore(fixture.root)
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'))
    const refresh = vi
      .spyOn(repositories, 'refresh')
      .mockRejectedValue(new Error('network forbidden'))
    const resolver = new PluginCatalogImageOnDemand({
      cache: fixture.cache,
      store: fixture.store,
      repositories
    })
    const handler = createPluginImageRequestHandler({
      cache: fixture.cache,
      ensureCatalogImage: (hash) => resolver.ensureCached(hash),
      findValidPlugin: () => null,
      findApprovedPlugin: () => null
    })

    const response = await handler(request(fixture.image.sha256))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(fixture.bytes)
    expect(await readFile(join(fixture.root, 'images', fixture.image.sha256))).toEqual(
      fixture.bytes
    )
    expect(network).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
    await writeFile(join(fixture.root, 'images', fixture.image.sha256), 'corrupt')
    expect(await fixture.cache.get(fixture.image.sha256)).toBeNull()
  })

  it.each([
    { name: 'wrong hash', declared: { sha256: 'f'.repeat(64) } },
    { name: 'wrong dimensions', declared: { width: 1280 } },
    { name: 'wrong kind', kind: 'icon' as const },
    { name: 'oversized cover', bytes: pngImageBytes(1600, 1000, 1024 * 1024 + 1) }
  ])('refuses $name without caching bytes', async (input) => {
    const fixture = await imageCatalog(input)
    const response = await fixture.handler(request(fixture.image.sha256))
    expect(response.status).toBe(404)
    expect(await fixture.cache.get(fixture.image.sha256)).toBeNull()
  })

  it('returns 404 and caches nothing when the bounded local read times out', async () => {
    const fixture = await imageCatalog()
    fixture.readImages.mockRejectedValue(new Error('Git timed out'))
    const response = await fixture.handler(request(fixture.image.sha256))
    expect(response.status).toBe(404)
    expect(await fixture.cache.get(fixture.image.sha256)).toBeNull()
  })

  it('shares one cold read between concurrent requests for a hash', async () => {
    const fixture = await imageCatalog()
    const bothEntered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<Map<string, Buffer>>()
    fixture.readImages.mockImplementation(() => release.promise)
    let entered = 0
    const handler = createPluginImageRequestHandler({
      cache: fixture.cache,
      ensureCatalogImage: (hash) => {
        entered++
        if (entered === 2) {
          bothEntered.resolve()
        }
        return fixture.resolver.ensureCached(hash)
      },
      findValidPlugin: () => null,
      findApprovedPlugin: () => null
    })
    const first = handler(request(fixture.image.sha256))
    const second = handler(request(fixture.image.sha256))
    await bothEntered.promise
    release.resolve(new Map([[fixture.image.path, fixture.bytes]]))
    const responses = await Promise.all([first, second])
    expect(responses.map((response) => response.status)).toEqual([200, 200])
    expect(fixture.readImages).toHaveBeenCalledTimes(1)
    expect(await readFile(join(fixture.root, 'images', fixture.image.sha256))).toEqual(
      fixture.bytes
    )
  })
  it.each([
    { kind: 'icon' as const, width: 1600, height: 1000 },
    { kind: 'cover' as const, width: 1280, height: 1000 }
  ])(
    'rejects an invalid cached use while preserving the valid cover: $kind $width',
    async (identity) => {
      const fixture = await imageCatalog()
      await fixture.cache.put(fixture.bytes)
      const invalid = await fixture.handler(
        new Request(pluginShaImageUrl(fixture.image.sha256, identity))
      )
      const valid = await fixture.handler(
        new Request(
          pluginShaImageUrl(fixture.image.sha256, { kind: 'cover', width: 1600, height: 1000 })
        )
      )
      expect(invalid.status).toBe(404)
      expect(valid.status).toBe(200)
      expect(await fixture.cache.get(fixture.image.sha256)).not.toBeNull()
    }
  )
})
