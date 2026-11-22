import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  PluginCatalogImages,
  PluginImageKind
} from '../../../shared/plugins/images/plugin-image-fields'
import {
  pluginShaImageUrl,
  type PluginCatalogImageIdentity
} from '../../../shared/plugins/images/plugin-image-url'
import { pluginMarketplaceListing } from '../catalog/plugin-marketplace-projection'
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
    releaseCount?: number
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
        releases: Array.from({ length: options.releaseCount ?? 1 }, (_, index) => ({
          version: `1.0.${index}`,
          minimumOrca: '1.4.0',
          execution: 'data' as const,
          commit: 'a'.repeat(40),
          contentHash: 'b'.repeat(64),
          images
        }))
      }
    ]
  }
  await store.writeSnapshot({ source, marketplaceCommit: 'c'.repeat(40), marketplace })
  const cache = new PluginImageCache(join(root, 'images'))
  const readImages = vi.fn<PluginCatalogRepositoryStore['readImages']>(
    async () => new Map([[image.path, bytes]])
  )
  const resolver = new PluginCatalogImageOnDemand({ cache, store, repositories: { readImages } })
  const handler = createPluginImageRequestHandler({
    cache,
    readCatalogImage: (reference, signal) => resolver.read(reference, signal),
    findValidPlugin: () => null,
    findApprovedPlugin: () => null
  })
  const request = (
    input: {
      commit?: string
      path?: string
      sourceId?: string
      sha256?: string
      identity?: PluginCatalogImageIdentity
      signal?: AbortSignal
    } = {}
  ) =>
    new Request(
      pluginShaImageUrl(
        input.sha256 ?? image.sha256,
        input.identity ?? {
          kind: kind as PluginCatalogImageIdentity['kind'],
          width: image.width,
          height: image.height
        },
        {
          sourceId: input.sourceId ?? source.id,
          commit: input.commit ?? 'c'.repeat(40),
          path: input.path ?? image.path
        }
      ),
      { signal: input.signal }
    )
  return {
    root,
    bytes,
    image,
    cache,
    source,
    store,
    marketplace,
    resolver,
    handler,
    readImages,
    request
  }
}

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
      readCatalogImage: (reference, signal) => resolver.read(reference, signal),
      findValidPlugin: () => null,
      findApprovedPlugin: () => null
    })

    const response = await handler(fixture.request({ commit }))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(fixture.bytes)
    expect(await readFile(join(fixture.root, 'images', fixture.image.sha256))).toEqual(
      fixture.bytes
    )
    expect(network).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
    await repositories.remove(fixture.source.id)
    const cached = await handler(fixture.request({ commit }))
    expect(cached.status).toBe(200)
    expect(Buffer.from(await cached.arrayBuffer())).toEqual(fixture.bytes)
  })

  it.each([
    { name: 'wrong hash', declared: { sha256: 'f'.repeat(64) } },
    { name: 'wrong dimensions', declared: { width: 1280 } },
    { name: 'wrong kind', kind: 'icon' as const },
    { name: 'oversized cover', bytes: pngImageBytes(1600, 1000, 1024 * 1024 + 1) }
  ])('refuses $name without caching bytes', async (input) => {
    const fixture = await imageCatalog(input)
    const response = await fixture.handler(fixture.request())
    expect(response.status).toBe(404)
    expect(
      await fixture.cache.get(catalogImageFixture('actual.png', fixture.bytes).sha256)
    ).toBeNull()
  })

  it('returns 404 and caches nothing when the bounded local read times out', async () => {
    const fixture = await imageCatalog()
    fixture.readImages.mockRejectedValue(new Error('Git timed out'))
    const response = await fixture.handler(fixture.request())
    expect(response.status).toBe(404)
    expect(
      await fixture.cache.get(catalogImageFixture('actual.png', fixture.bytes).sha256)
    ).toBeNull()
  })

  it('checks a missing file once even if 32 releases declare it', async () => {
    const fixture = await imageCatalog({ releaseCount: 32 })
    fixture.readImages.mockResolvedValue(new Map())

    expect((await fixture.handler(fixture.request())).status).toBe(404)
    expect(fixture.readImages).toHaveBeenCalledTimes(1)
  })

  it('retries a failed read after republishing the same commit', async () => {
    const fixture = await imageCatalog()
    fixture.readImages.mockResolvedValueOnce(new Map())
    expect((await fixture.handler(fixture.request())).status).toBe(404)

    await fixture.store.writeSnapshot({
      source: fixture.source,
      marketplaceCommit: 'c'.repeat(40),
      marketplace: fixture.marketplace,
      fetchedAt: 10
    })

    expect((await fixture.handler(fixture.request())).status).toBe(200)
  })

  it('resolves a previously issued URL against the current catalog declaration', async () => {
    const fixture = await imageCatalog()
    const oldUrl = new URL(fixture.request().url)
    oldUrl.searchParams.set('fetchedAt', '1')
    const marketplaceCommit = 'd'.repeat(40)
    fixture.readImages.mockImplementation(async (_source, commit) =>
      commit === marketplaceCommit ? new Map([[fixture.image.path, fixture.bytes]]) : new Map()
    )
    await fixture.store.writeSnapshot({
      source: fixture.source,
      marketplaceCommit,
      marketplace: fixture.marketplace
    })

    const response = await fixture.handler(new Request(oldUrl))
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(fixture.bytes)

    await fixture.store.writeSnapshot({
      source: fixture.source,
      marketplaceCommit: 'e'.repeat(40),
      marketplace: { ...fixture.marketplace, plugins: [] }
    })
    expect((await fixture.handler(fixture.request())).status).toBe(404)
  })

  it('rechecks the declaration after a queued read loses its published commit', async () => {
    const fixture = await imageCatalog()
    fixture.readImages.mockImplementationOnce(async () => {
      await fixture.store.writeSnapshot({
        source: fixture.source,
        marketplaceCommit: 'd'.repeat(40),
        marketplace: fixture.marketplace
      })
      return new Map()
    })

    expect((await fixture.handler(fixture.request())).status).toBe(200)
  })

  it('keeps a same-commit image URL and its verified file across refreshes', async () => {
    const fixture = await imageCatalog()
    const listing = async (fetchedAt: number) => {
      const snapshot = await fixture.store.writeSnapshot({
        source: fixture.source,
        marketplaceCommit: 'c'.repeat(40),
        marketplace: fixture.marketplace,
        fetchedAt
      })
      return pluginMarketplaceListing({
        source: fixture.source,
        snapshot,
        entry: snapshot.marketplace.plugins[0]!,
        hostVersion: null,
        blocked: null
      }).images!.cover!
    }

    const first = await listing(1)
    expect((await fixture.handler(new Request(first.url))).status).toBe(200)
    fixture.readImages.mockRejectedValue(new Error('Git unavailable'))

    const next = await listing(2)
    expect(next.url).toBe(first.url)
    expect((await fixture.handler(new Request(next.url))).status).toBe(200)
  })

  it('authorizes the complete declaration before serving verified catalog bytes', async () => {
    const fixture = await imageCatalog()
    expect((await fixture.handler(fixture.request())).status).toBe(200)

    const { width, height } = fixture.image
    for (const input of [
      { path: 'unlisted.png' },
      { sha256: 'f'.repeat(64) },
      { identity: { kind: 'screenshot', width, height } },
      { identity: { kind: 'cover', width: 1280, height } },
      { identity: { kind: 'cover', width, height: 800 } }
    ] as const) {
      expect((await fixture.handler(fixture.request(input))).status).toBe(404)
    }
  })

  it('requires the new commit to prove a warm declaration at the same path', async () => {
    const fixture = await imageCatalog()
    expect((await fixture.handler(fixture.request())).status).toBe(200)
    fixture.readImages.mockResolvedValue(new Map())
    await fixture.store.writeSnapshot({
      source: fixture.source,
      marketplaceCommit: 'd'.repeat(40),
      marketplace: fixture.marketplace
    })

    expect((await fixture.handler(fixture.request())).status).toBe(404)
  })

  it('does not use a warm hash to satisfy a different catalog path', async () => {
    const fixture = await imageCatalog()
    const other = await fixture.store.addSource({ ...fixture.source.source, ref: 'release' })
    const marketplace = structuredClone(fixture.marketplace)
    marketplace.plugins[0]!.releases[0]!.images.cover!.path = 'missing.png'
    await fixture.store.writeSnapshot({
      source: other,
      marketplaceCommit: 'c'.repeat(40),
      marketplace
    })
    expect((await fixture.handler(fixture.request())).status).toBe(200)

    expect(
      (await fixture.handler(fixture.request({ sourceId: other.id, path: 'missing.png' }))).status
    ).toBe(404)
    expect((await fixture.handler(fixture.request({ sourceId: other.id }))).status).toBe(404)
  })

  it('shares an in-flight read through cancellation of one matching request', async () => {
    const fixture = await imageCatalog()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<Map<string, Buffer>>()
    fixture.readImages.mockResolvedValue(new Map())
    fixture.readImages.mockImplementationOnce(async (_source, _commit, _paths, signal) => {
      signal!.addEventListener('abort', () => release.resolve(new Map()), { once: true })
      entered.resolve()
      return release.promise
    })
    const controller = new AbortController()
    const first = fixture.handler(fixture.request({ signal: controller.signal }))
    await entered.promise
    const followers = Array.from({ length: 31 }, () => fixture.handler(fixture.request()))
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      controller.abort()
      release.resolve(new Map([[fixture.image.path, fixture.bytes]]))

      expect((await first).status).toBe(404)
      for (const response of await Promise.all(followers)) {
        expect(response.status).toBe(200)
      }
    } finally {
      controller.abort()
      release.resolve(new Map())
    }
  })

  it('serves another catalog while a read is blocked and cancels the abandoned Git batch', async () => {
    const fixture = await imageCatalog()
    const other = await fixture.store.addSource({ ...fixture.source.source, ref: 'release' })
    await fixture.store.writeSnapshot({
      source: other,
      marketplaceCommit: 'c'.repeat(40),
      marketplace: fixture.marketplace
    })
    const started = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<Map<string, Buffer>>()
    fixture.readImages.mockImplementationOnce(async (_source, _commit, _paths, signal) => {
      signal!.addEventListener('abort', () => release.resolve(new Map()), { once: true })
      started.resolve(signal!)
      return release.promise
    })
    const controller = new AbortController()
    const first = fixture.handler(fixture.request({ signal: controller.signal }))
    const signal = await started.promise
    try {
      const second = fixture.handler(fixture.request({ sourceId: other.id }))
      const response = await Promise.race([
        second,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error('catalogs shared a read queue')), 5000)
          timer.unref()
        })
      ])
      expect(response).toMatchObject({ status: 200 })
      controller.abort()
      expect(signal.aborted).toBe(true)
      expect((await first).status).toBe(404)
    } finally {
      controller.abort()
      release.resolve(new Map())
    }
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
