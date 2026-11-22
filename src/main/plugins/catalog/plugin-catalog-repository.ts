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
      const { commit, value } = await readRetainedPluginGitCommit(
        {
          url: source.source.url,
          ref: source.source.ref,
          repository,
          maxDownloadBytes: this.maxDownloadBytes,
          reusable,
          publishedCommit: published?.marketplaceCommit
        },
        async (commit) => ({ commit, value: await save(repository, commit, slot) })
      )
      try {
        // Readers already using the previous snapshot get to finish before its objects are pruned.
        await this.waitForReaders(source.id)
        await pinRetainedPluginGitCommit(repository, commit)
        await rm(join(directory, slot === 'repository' ? 'replacement' : 'repository'), {
          recursive: true,
          force: true
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
    return this.serial(sourceId, async () => {
      await this.waitForReaders(sourceId)
      await rm(this.directory(sourceId), { recursive: true, force: true })
    })
  }

  private async waitForReaders(sourceId: string): Promise<void> {
    await Promise.allSettled(this.readers.get(sourceId) ?? [])
  }
}
