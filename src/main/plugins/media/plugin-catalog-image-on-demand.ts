import {
  PLUGIN_IMAGE_RULES,
  type PluginImageKind
} from '../../../shared/plugins/images/plugin-image-fields'
import { pluginRelativePathSchema } from '../../../shared/plugins/manifest/plugin-manifest-fields'
import { validateCatalogImage, type CatalogImage } from '../catalog/plugin-catalog-image-extraction'
import { isOnDemandCatalogSource } from '../catalog/plugin-marketplace-fetch'
import type { PluginCatalogRepositoryStore } from '../catalog/plugin-catalog-repository'
import type { PluginMarketplaceStore } from '../catalog/plugin-marketplace-store'
import type { PluginImageCache } from './plugin-image-cache'

const IMAGE_BATCH_SIZE = 6
const FAILURE_RETRY_MS = 3 * 60_000

type ImageLocation = {
  sourceId: string
  commit: string
  image: CatalogImage
  kind: PluginImageKind
}
type PendingImage = { hash: string; finish: () => void; locations: ImageLocation[] }

/** Coalesces visible image requests into local Git batches; no network recovery is permitted here. */
export class PluginCatalogImageOnDemand {
  private readonly inFlight = new Map<string, Promise<void>>()
  private readonly failures = new Map<string, number>()
  private readonly pending: PendingImage[] = []
  private scheduled = false
  private reading = false

  constructor(
    private readonly options: {
      cache: PluginImageCache
      store: Pick<PluginMarketplaceStore, 'listSources' | 'readSnapshot'>
      repositories: Pick<PluginCatalogRepositoryStore, 'readImages'>
    }
  ) {}

  ensureCached(hash: string): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(hash) || (this.failures.get(hash) ?? 0) > Date.now()) {
      return Promise.resolve()
    }
    const existing = this.inFlight.get(hash)
    if (existing) {
      return existing
    }
    const task = this.options.cache
      .get(hash)
      .catch(() => null)
      .then((cached) => {
        if (cached) {
          return
        }
        return new Promise<void>((finish) => {
          this.pending.push({ hash, finish, locations: [] })
          this.schedule()
        })
      })
      .finally(() => {
        if (this.inFlight.get(hash) === task) {
          this.inFlight.delete(hash)
        }
      })
    this.inFlight.set(hash, task)
    return task
  }

  private schedule(): void {
    if (this.scheduled || this.reading || this.pending.length === 0) {
      return
    }
    this.scheduled = true
    setTimeout(() => {
      this.scheduled = false
      void this.readBatch()
    }, 0)
  }

  private async locate(jobs: PendingImage[]): Promise<void> {
    const wanted = new Map(jobs.map((job) => [job.hash, job]))
    for (const source of await this.options.store.listSources()) {
      if (!isOnDemandCatalogSource(source.source.url)) {
        continue
      }
      const snapshot = await this.options.store.readSnapshot(source.id).catch(() => null)
      if (!snapshot || !/^[0-9a-f]{40}$/.test(snapshot.marketplaceCommit)) {
        continue
      }
      for (const entry of snapshot.marketplace.plugins) {
        if (!('releases' in entry)) {
          continue
        }
        for (const release of entry.releases ?? []) {
          const add = (kind: PluginImageKind, image: CatalogImage | undefined): void => {
            const job = image && wanted.get(image.sha256)
            if (job && image && pluginRelativePathSchema.safeParse(image.path).success) {
              job.locations.push({
                sourceId: source.id,
                commit: snapshot.marketplaceCommit,
                kind,
                image
              })
            }
          }
          add('icon', release.images?.icon)
          add('cover', release.images?.cover)
          for (const shot of release.images?.screenshots ?? []) {
            add('screenshot', shot)
          }
        }
      }
    }
  }

  private async readBatch(): Promise<void> {
    this.reading = true
    const jobs = this.pending.splice(0, IMAGE_BATCH_SIZE)
    const accepted = new Set<string>()
    try {
      await this.locate(jobs)
      while (jobs.some((job) => !accepted.has(job.hash) && job.locations.length > 0)) {
        const groups = new Map<
          string,
          { location: ImageLocation; uses: { job: PendingImage; location: ImageLocation }[] }
        >()
        for (const job of jobs) {
          if (accepted.has(job.hash)) {
            continue
          }
          const location = job.locations.shift()
          if (!location) {
            continue
          }
          const key = `${location.sourceId}:${location.commit}`
          const group = groups.get(key) ?? { location, uses: [] }
          group.uses.push({ job, location })
          groups.set(key, group)
        }
        await Promise.all(
          [...groups.values()].map(async ({ location, uses }) => {
            const paths = new Map<string, number>()
            for (const use of uses) {
              paths.set(
                use.location.image.path,
                Math.max(
                  paths.get(use.location.image.path) ?? 0,
                  PLUGIN_IMAGE_RULES[use.location.kind].maxBytes
                )
              )
            }
            const files = await this.options.repositories
              .readImages(location.sourceId, location.commit, paths)
              .catch(() => new Map<string, Buffer>())
            for (const use of uses) {
              const bytes = files.get(use.location.image.path)
              if (
                bytes &&
                validateCatalogImage(bytes, use.location.image, use.location.kind) &&
                (await this.options.cache.put(bytes))
              ) {
                accepted.add(use.job.hash)
              }
            }
          })
        )
      }
    } catch {
      // A broken catalog must leave other cards usable and permit a later retry.
    } finally {
      for (const [hash, until] of this.failures) {
        if (until <= Date.now()) {
          this.failures.delete(hash)
        }
      }
      for (const job of jobs) {
        if (!accepted.has(job.hash)) {
          this.failures.set(job.hash, Date.now() + FAILURE_RETRY_MS)
        }
        job.finish()
      }
      this.reading = false
      this.schedule()
    }
  }
}
