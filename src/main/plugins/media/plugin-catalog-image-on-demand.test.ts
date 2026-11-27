import { PluginMarketplaceTeamPolicy } from '../catalog/plugin-marketplace-team-policy'
import { ORCA_CLOUD_TEAM_POLICY_FLAGS } from '../../../shared/orca-profiles/orca-cloud-team-policy'
import type { OrcaCloudCapabilities } from '../../../shared/orca-profiles/orca-cloud-capabilities'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginCatalogImages } from '../../../shared/plugins/images/plugin-image-fields'
import {
  pluginShaImageUrl,
  type PluginCatalogImageIdentity
} from '../../../shared/plugins/images/plugin-image-url'
import { pluginMarketplaceListing } from '../catalog/plugin-marketplace-projection'
import { PluginMarketplaceStore } from '../catalog/plugin-marketplace-store'
import {
  PluginCatalogRepositoryStore,
  type CatalogImageListing,
  type CatalogImageRead
} from '../catalog/plugin-catalog-repository'
import type { ListedBlob } from '../catalog/plugin-catalog-blob-reader'
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
    kind?: 'icon' | 'cover'
    declared?: { sha256?: string; width?: number }
    releaseCount?: number
    getCapabilities?: () => OrcaCloudCapabilities | undefined
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'orca-catalog-image-'))
  roots.push(root)
  const bytes = options.bytes ?? pngImageBytes(1600, 1000)
  const image = {
    ...catalogImageFixture('cover.png', bytes),
    ...options.declared
  }
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
  await store.writeSnapshot({
    source,
    marketplaceCommit: 'c'.repeat(40),
    marketplace
  })
  const cache = new PluginImageCache(join(root, 'images'))
  const readImages = vi.fn<
    (id: string, request: CatalogImageRead, signal?: AbortSignal) => Promise<Map<string, Buffer>>
  >(async () => new Map([[image.path, bytes]]))
  const admit = vi.fn<PluginCatalogRepositoryStore['readImages']>()
  admit.mockImplementation(async (id, select, signal) => {
    const request = select()
    return request ? readImages(id, request, signal) : new Map()
  })
  // Why null by default: without a listing, every unverified read must go through readImages.
  const listImages = vi.fn<
    (id: string, request: CatalogImageListing) => Promise<Map<string, ListedBlob> | null>
  >(async () => null)
  const list = vi.fn<PluginCatalogRepositoryStore['listImages']>(async (id, select) => {
    const request = select()
    return request ? listImages(id, request) : null
  })
  const start = () => {
    const resolver = new PluginCatalogImageOnDemand({
      cache,
      store,
      repositories: { readImages: admit, listImages: list },
      policy: new PluginMarketplaceTeamPolicy(options.getCapabilities)
    })
    const handler = createPluginImageRequestHandler({
      cache,
      readCatalogImage: (reference, signal) => resolver.read(reference, signal),
      findValidPlugin: () => null,
      findApprovedPlugin: () => null
    })
    return { resolver, handler }
  }
  const { resolver, handler } = start()
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
          kind,
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
    admit,
    readImages,
    listImages,
    start,
    request
  }
}

function gitBlobId(bytes: Buffer): string {
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex')
}

describe('on-demand catalog image protocol', () => {
  it('does not serve a catalog image after team policy blocks its source', async () => {
    let blocked = true
    const fixture = await imageCatalog({
      getCapabilities: () => ({
        flags: { [ORCA_CLOUD_TEAM_POLICY_FLAGS.allowMemberSources]: !blocked },
        refreshedAt: 0
      })
    })
    expect((await fixture.handler(fixture.request())).status).toBe(404)
    expect(fixture.readImages).not.toHaveBeenCalled()
    blocked = false
    expect((await fixture.handler(fixture.request())).status).toBe(200)
    blocked = true
    expect((await fixture.handler(fixture.request())).status).toBe(404)
    expect(fixture.readImages).toHaveBeenCalledTimes(1)
  })

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
    const serve = (store: PluginMarketplaceStore, retained: PluginCatalogRepositoryStore) => {
      const resolver = new PluginCatalogImageOnDemand({
        cache: fixture.cache,
        store,
        repositories: retained,
        policy: new PluginMarketplaceTeamPolicy()
      })
      return createPluginImageRequestHandler({
        cache: fixture.cache,
        readCatalogImage: (reference, signal) => resolver.read(reference, signal),
        findValidPlugin: () => null,
        findApprovedPlugin: () => null
      })
    }
    const handler = serve(fixture.store, repositories)

    const writeCache = vi.spyOn(fixture.cache, 'put')
    const response = await handler(fixture.request({ commit }))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(fixture.bytes)
    await writeCache.mock.results[0]!.value
    expect(await readFile(join(fixture.root, 'images', fixture.image.sha256))).toEqual(
      fixture.bytes
    )
    expect(network).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()

    // After a restart, Git's listed blob id proves the cached bytes without reading the blob.
    const restartedRepositories = new PluginCatalogRepositoryStore(fixture.root)
    const readAfterRestart = vi.spyOn(restartedRepositories, 'readImages')
    const listAfterRestart = vi.spyOn(restartedRepositories, 'listImages')
    const restarted = serve(new PluginMarketplaceStore(fixture.root), restartedRepositories)
    const proven = await restarted(fixture.request({ commit }))
    expect(proven.status).toBe(200)
    expect(Buffer.from(await proven.arrayBuffer())).toEqual(fixture.bytes)
    expect(listAfterRestart).toHaveBeenCalledTimes(1)
    expect(readAfterRestart).not.toHaveBeenCalled()

    await repositories.remove(fixture.source.id)
    const cached = await handler(fixture.request({ commit }))
    expect(cached.status).toBe(200)
    expect(Buffer.from(await cached.arrayBuffer())).toEqual(fixture.bytes)
  })

  it.each([
    { name: 'wrong hash', declared: { sha256: 'f'.repeat(64) } },
    { name: 'wrong dimensions', declared: { width: 1280 } },
    { name: 'wrong kind', kind: 'icon' as const },
    {
      name: 'oversized cover',
      bytes: pngImageBytes(1600, 1000, 1024 * 1024 + 1)
    }
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
    fixture.readImages.mockImplementation(async (_source, request) =>
      request.commit === marketplaceCommit
        ? new Map([[fixture.image.path, fixture.bytes]])
        : new Map()
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
    expect(fixture.readImages.mock.calls.map(([, read]) => read.commit)).toEqual([
      'c'.repeat(40),
      'd'.repeat(40)
    ])
  })

  it.each([true, false])(
    'reauthorizes a barrier-blocked read after two publications (retained: %s)',
    async (retained) => {
      const f = await imageCatalog()
      const waiting = Promise.withResolvers<void>()
      const barrier = Promise.withResolvers<void>()
      const admit = f.admit.getMockImplementation()!
      f.admit.mockImplementationOnce(async (...args) => {
        waiting.resolve()
        await barrier.promise
        return admit(...args)
      })
      const response = f.handler(f.request())
      await waiting.promise
      try {
        await f.store.writeSnapshot({
          source: f.source,
          marketplaceCommit: 'd'.repeat(40),
          marketplace: f.marketplace
        })
        await f.store.writeSnapshot({
          source: f.source,
          marketplaceCommit: 'e'.repeat(40),
          catalogRepository: 'replacement',
          marketplace: retained ? f.marketplace : { ...f.marketplace, plugins: [] }
        })
      } finally {
        barrier.resolve()
      }
      const result = await response
      if (retained) {
        expect(result.status).toBe(200)
        expect(Buffer.from(await result.arrayBuffer())).toEqual(f.bytes)
        expect(f.readImages.mock.calls.map(([, read]) => [read.commit, read.slot])).toEqual([
          ['e'.repeat(40), 'replacement']
        ])
      } else {
        expect(result.status).toBe(404)
        expect(f.readImages).not.toHaveBeenCalled()
      }
    }
  )

  it('denies a warm read at delivery after the registration is removed and re-added', async () => {
    const f = await imageCatalog()
    expect((await f.handler(f.request())).status).toBe(200)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const get = f.cache.get.bind(f.cache)
    vi.spyOn(f.cache, 'get').mockImplementationOnce(async (sha) => {
      entered.resolve()
      await release.promise
      return get(sha)
    })
    const response = f.handler(f.request())
    await entered.promise
    try {
      await f.store.removeSource(f.source.id)
      const restarted = await f.store.addSource(f.source.source, f.source.addedAt)
      await f.store.writeSnapshot({
        source: restarted,
        marketplaceCommit: 'c'.repeat(40),
        marketplace: f.marketplace
      })
    } finally {
      release.resolve()
    }
    expect((await response).status).toBe(404)
    expect((await f.handler(f.request())).status).toBe(200)
    expect(f.readImages).toHaveBeenCalledTimes(2)
  })

  it('keeps an admitted read across publication and checks live policy before delivery', async () => {
    let capabilities: OrcaCloudCapabilities | undefined
    const f = await imageCatalog({ getCapabilities: () => capabilities })
    const heldRequest = async (revoke: boolean) => {
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<Map<string, Buffer>>()
      f.readImages.mockImplementationOnce(() => {
        entered.resolve()
        return release.promise
      })
      const response = f.handler(f.request())
      await entered.promise
      try {
        await f.store.writeSnapshot({
          source: f.source,
          marketplaceCommit: 'e'.repeat(40),
          marketplace: { ...f.marketplace, plugins: [] }
        })
        if (revoke) {
          capabilities = {
            flags: { [ORCA_CLOUD_TEAM_POLICY_FLAGS.plugins]: false },
            refreshedAt: 1
          }
        }
      } finally {
        release.resolve(new Map([[f.image.path, f.bytes]]))
      }
      return response
    }
    const admitted = await heldRequest(false)
    expect(admitted.status).toBe(200)
    expect(Buffer.from(await admitted.arrayBuffer())).toEqual(f.bytes)
    await f.store.writeSnapshot({
      source: f.source,
      marketplaceCommit: 'd'.repeat(40),
      marketplace: f.marketplace
    })
    expect((await heldRequest(true)).status).toBe(404)
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
      })!.images!.cover!
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
    const other = await imageCatalog({
      bytes: pngImageBytes(1600, 1000, 64, 1)
    })
    await fixture.cache.put(other.bytes)

    const { width, height } = fixture.image
    for (const input of [
      { path: 'unlisted.png' },
      { sha256: other.image.sha256 },
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
    expect(fixture.readImages.mock.lastCall?.[1]).toMatchObject({
      commit: 'd'.repeat(40),
      slot: 'repository',
      paths: new Map([[fixture.image.path, 1024 * 1024]])
    })
  })

  it('serves cached bytes after a restart when the commit lists their blob id', async () => {
    const f = await imageCatalog()
    expect((await f.handler(f.request())).status).toBe(200)
    await vi.waitFor(async () => expect(await f.cache.get(f.image.sha256)).not.toBeNull())
    f.listImages.mockResolvedValue(
      new Map([[f.image.path, { object: gitBlobId(f.bytes), size: f.bytes.byteLength }]])
    )

    const restarted = f.start()
    const response = await restarted.handler(f.request())
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(f.bytes)
    expect(f.readImages).toHaveBeenCalledTimes(1)
    expect(f.listImages.mock.lastCall?.[1]).toMatchObject({
      commit: 'c'.repeat(40),
      slot: 'repository',
      paths: new Set([f.image.path])
    })
    // Proven once, later requests skip the listing too.
    expect((await restarted.handler(f.request())).status).toBe(200)
    expect(f.listImages).toHaveBeenCalledTimes(2)
  })

  it('reads the blob when the listed id differs from the cached bytes', async () => {
    const f = await imageCatalog()
    await f.cache.put(f.bytes)
    f.listImages.mockResolvedValue(
      new Map([[f.image.path, { object: 'f'.repeat(40), size: f.bytes.byteLength }]])
    )
    f.readImages.mockResolvedValue(new Map())

    expect((await f.handler(f.request())).status).toBe(404)
    expect(f.readImages).toHaveBeenCalledTimes(1)
    expect(f.readImages.mock.lastCall?.[1].listed?.get(f.image.path)?.object).toBe('f'.repeat(40))
  })

  it('does not prove a warm hash through another path or an unlisted commit', async () => {
    const f = await imageCatalog()
    await f.cache.put(f.bytes)
    f.listImages.mockResolvedValue(
      new Map([['other.png', { object: gitBlobId(f.bytes), size: f.bytes.byteLength }]])
    )
    f.readImages.mockResolvedValue(new Map())
    expect((await f.handler(f.request())).status).toBe(404)

    f.listImages.mockResolvedValue(null)
    await f.store.writeSnapshot({
      source: f.source,
      marketplaceCommit: 'd'.repeat(40),
      marketplace: f.marketplace
    })
    expect((await f.handler(f.request())).status).toBe(404)
    expect(f.readImages).toHaveBeenCalledTimes(2)
    expect(f.listImages.mock.lastCall?.[1].commit).toBe('d'.repeat(40))
  })

  it('rejects incomplete catalog locations while preserving locationless previews', async () => {
    const f = await imageCatalog()
    await f.cache.put(f.bytes)
    for (const field of ['kind', 'source', 'commit', 'path']) {
      const url = new URL(f.request().url)
      url.searchParams.delete(field)
      expect((await f.handler(new Request(url))).status, field).toBe(404)
    }
    const preview = pluginShaImageUrl(f.image.sha256, {
      ...f.image,
      kind: 'cover'
    })
    const response = await f.handler(new Request(preview))
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(f.bytes)
  })

  it('does not use a warm hash to satisfy a different catalog path', async () => {
    const fixture = await imageCatalog()
    const other = await fixture.store.addSource({
      ...fixture.source.source,
      ref: 'release'
    })
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
    fixture.readImages.mockImplementationOnce(async (_source, _select, signal) => {
      signal!.addEventListener('abort', () => release.resolve(new Map()), {
        once: true
      })
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
    const other = await fixture.store.addSource({
      ...fixture.source.source,
      ref: 'release'
    })
    await fixture.store.writeSnapshot({
      source: other,
      marketplaceCommit: 'c'.repeat(40),
      marketplace: fixture.marketplace
    })
    const started = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<Map<string, Buffer>>()
    fixture.readImages.mockImplementationOnce(async (_source, _select, signal) => {
      signal!.addEventListener('abort', () => release.resolve(new Map()), {
        once: true
      })
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
          pluginShaImageUrl(fixture.image.sha256, {
            kind: 'cover',
            width: 1600,
            height: 1000
          })
        )
      )
      expect(invalid.status).toBe(404)
      expect(valid.status).toBe(200)
      expect(await fixture.cache.get(fixture.image.sha256)).not.toBeNull()
    }
  )
})
