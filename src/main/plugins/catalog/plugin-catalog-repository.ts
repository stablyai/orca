import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  isReusableCatalogRepository,
  pinRetainedPluginGitCommit,
  readRetainedPluginGitCommit
} from './plugin-catalog-git-repository'
import {
  PLUGIN_MARKETPLACE_SOURCE_ID_PATTERN,
  snapshotRepositorySlot,
  type CatalogRepositorySlot,
  type PluginMarketplaceCachedSnapshot,
  type PluginMarketplaceRegisteredSource
} from './plugin-marketplace-store'
import { readCatalogImageBlobs } from './plugin-catalog-blob-reader'

const CATALOG_DOWNLOAD_MAX_BYTES = 512 * 1024 * 1024

export class PluginCatalogRepositoryStore {
  private readonly mutations = new Map<string, Promise<unknown>>()
  private readonly readers = new Map<string, Set<Promise<unknown>>>()
  private readonly readBarriers = new Map<string, Promise<void>>()
  private readonly root: string

  constructor(
    pluginsDataDir: string,
    private readonly maxDownloadBytes = CATALOG_DOWNLOAD_MAX_BYTES
  ) {
    this.root = join(pluginsDataDir, 'catalog-repositories')
  }

  private directory(sourceId: string): string {
    if (!PLUGIN_MARKETPLACE_SOURCE_ID_PATTERN.test(sourceId)) {
      throw new Error('invalid catalog source identity')
    }
    return join(this.root, sourceId)
  }

  private async serial<T>(sourceId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(sourceId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(run)
    this.mutations.set(sourceId, next)
    try {
      return await next
    } finally {
      if (this.mutations.get(sourceId) === next) {
        this.mutations.delete(sourceId)
      }
    }
  }

  refresh<T>(
    source: PluginMarketplaceRegisteredSource,
    published: PluginMarketplaceCachedSnapshot | null,
    save: (repository: string, commit: string, slot: CatalogRepositorySlot) => Promise<T>
  ): Promise<T> {
    return this.serial(source.id, async () => {
      const directory = this.directory(source.id)
      const currentSlot = snapshotRepositorySlot(published)
      const current = join(directory, currentSlot)
      const reusable = await isReusableCatalogRepository(
        current,
        source.source.url,
        published?.marketplaceCommit
      )
      const slot =
        reusable || !published
          ? currentSlot
          : currentSlot === 'repository'
            ? 'replacement'
            : 'repository'
      const repository = join(directory, slot)
      const publishedCommit = published?.marketplaceCommit
      if (reusable && publishedCommit) {
        await pinRetainedPluginGitCommit(repository, publishedCommit, (prune) =>
          this.withoutReaders(source.id, prune)
        )
      }
      const { commit, value } = await readRetainedPluginGitCommit(
        {
          url: source.source.url,
          ref: source.source.ref,
          repository,
          maxDownloadBytes: this.maxDownloadBytes,
          reusable
        },
        async (commit) => ({ commit, value: await save(repository, commit, slot) })
      )
      try {
        await this.withoutReaders(source.id, async () => {
          await pinRetainedPluginGitCommit(repository, commit)
          await rm(join(directory, slot === 'repository' ? 'replacement' : 'repository'), {
            recursive: true,
            force: true
          })
        })
      } catch (error) {
        console.warn('[plugins] could not prune retained catalog repository:', error)
      }
      return value
    })
  }

  async readImages(
    sourceId: string,
    commit: string,
    paths: ReadonlyMap<string, number>,
    signal?: AbortSignal,
    slot: CatalogRepositorySlot = 'repository'
  ): Promise<Map<string, Buffer>> {
    let barrier = this.readBarriers.get(sourceId)
    while (barrier) {
      await barrier.catch(() => undefined)
      barrier = this.readBarriers.get(sourceId)
    }
    if (signal?.aborted) {
      return new Map()
    }
    const repository = join(this.directory(sourceId), slot)
    const read = readCatalogImageBlobs(repository, commit, paths, signal)
    const active = this.readers.get(sourceId) ?? new Set()
    this.readers.set(sourceId, active)
    active.add(read)
    try {
      return await read
    } finally {
      active.delete(read)
      if (active.size === 0) {
        this.readers.delete(sourceId)
      }
    }
  }

  async sweep(sources: Promise<readonly PluginMarketplaceRegisteredSource[]>): Promise<void> {
    const registered = new Set((await sources).map((source) => source.id))
    const folders = await readdir(this.root).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error
      }
      return []
    })
    await Promise.all(
      folders
        .filter(
          (folder) => PLUGIN_MARKETPLACE_SOURCE_ID_PATTERN.test(folder) && !registered.has(folder)
        )
        .map((folder) =>
          this.remove(folder).catch((error: unknown) => {
            console.warn('[plugins] could not remove orphaned catalog repository:', error)
          })
        )
    )
  }

  remove(sourceId: string): Promise<void> {
    return this.serial(sourceId, () =>
      this.withoutReaders(sourceId, () =>
        rm(this.directory(sourceId), { recursive: true, force: true })
      )
    )
  }

  private async withoutReaders(sourceId: string, run: () => Promise<void>): Promise<void> {
    // Close admission before yielding so the captured reader set cannot gain new readers.
    const readers = this.readers.get(sourceId)
    const barrier = (readers ? Promise.allSettled(readers) : Promise.resolve()).then(run)
    this.readBarriers.set(sourceId, barrier)
    try {
      await barrier
    } finally {
      this.readBarriers.delete(sourceId)
    }
  }
}
