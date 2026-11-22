import {
  PLUGIN_IMAGE_RULES,
  type PluginImageKind
} from '../../../shared/plugins/images/plugin-image-fields'
import {
  PLUGIN_IMAGE_MIME,
  readPluginImageHeader
} from '../../../shared/plugins/images/plugin-image-format'
import type { PluginImageReference } from '../../../shared/plugins/images/plugin-image-url'
import { validateCatalogImage, type CatalogImage } from '../catalog/plugin-catalog-image-extraction'
import type { PluginCatalogRepositoryStore } from '../catalog/plugin-catalog-repository'
import {
  snapshotRepositorySlot,
  type PluginMarketplaceCachedSnapshot,
  type PluginMarketplaceStore
} from '../catalog/plugin-marketplace-store'
import type { PluginImageCache } from './plugin-image-cache'
import type { CheckedPluginImage } from './plugin-image-read'

const IMAGE_BATCH_SIZE = 6

type CatalogReference = Extract<PluginImageReference, { kind: 'catalog' }>
type PendingImage = {
  snapshot: PluginMarketplaceCachedSnapshot
  path: string
  kind: PluginImageKind
  image: Pick<CatalogImage, 'sha256' | 'width' | 'height'>
  signal: AbortSignal
  finish: (asset: CheckedPluginImage | null) => void
}

function imageKey(
  kind: PluginImageKind,
  image: Pick<CatalogImage, 'path' | 'sha256' | 'width' | 'height'>
): string {
  return JSON.stringify([image.path, image.sha256, kind, image.width, image.height])
}

export class PluginCatalogImageOnDemand {
  private readonly locations = new WeakMap<PluginMarketplaceCachedSnapshot, Map<string, boolean>>()
  private readonly queues = new Map<string, PendingImage[]>()

  constructor(
    private readonly options: {
      cache: PluginImageCache
      store: Pick<PluginMarketplaceStore, 'listSources' | 'readSnapshot'>
      repositories: Pick<PluginCatalogRepositoryStore, 'readImages'>
    }
  ) {}

  async read(reference: CatalogReference, signal: AbortSignal): Promise<CheckedPluginImage | null> {
    const { sourceId, commit, path } = reference.location
    const sources = await this.options.store.listSources()
    if (signal.aborted || !sources.some((source) => source.id === sourceId)) {
      return null
    }
    const snapshot = await this.options.store.readSnapshot(sourceId)
    if (signal.aborted || snapshot?.marketplaceCommit !== commit) {
      return null
    }
    const image = { ...reference.image, path, sha256: reference.sha256 }
    const locations = this.locations.get(snapshot) ?? this.indexSnapshot(snapshot)
    const key = imageKey(image.kind, image)
    if (!locations.has(key)) {
      return null
    }
    if (locations.get(key)) {
      const cached = await this.options.cache.get(image.sha256)
      if (cached) {
        return cached
      }
    }
    const asset = await this.queue({ snapshot, path, kind: image.kind, image, signal })
    if (asset) {
      locations.set(key, true)
    }
    return asset
  }

  private indexSnapshot(snapshot: PluginMarketplaceCachedSnapshot): Map<string, boolean> {
    const locations = new Map<string, boolean>()
    const add = (kind: PluginImageKind, image: CatalogImage | undefined): void => {
      if (image) {
        locations.set(imageKey(kind, image), false)
      }
    }
    for (const entry of snapshot.marketplace.plugins) {
      if (!('releases' in entry)) {
        continue
      }
      for (const release of entry.releases ?? []) {
        add('icon', release.images?.icon)
        add('cover', release.images?.cover)
        for (const shot of release.images?.screenshots ?? []) {
          add('screenshot', shot)
        }
      }
    }
    this.locations.set(snapshot, locations)
    return locations
  }

  private queue(input: Omit<PendingImage, 'finish'>): Promise<CheckedPluginImage | null> {
    const {
      snapshot: { sourceId },
      signal
    } = input
    if (signal.aborted) {
      return Promise.resolve(null)
    }
    return new Promise((resolve) => {
      const pending = this.queues.get(sourceId) ?? []
      const onAbort = () => {
        const index = pending.indexOf(job)
        if (index !== -1) {
          pending.splice(index, 1)
        }
        finish(null)
      }
      const finish = (asset: CheckedPluginImage | null) => {
        signal.removeEventListener('abort', onAbort)
        resolve(asset)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      const job = { ...input, finish }
      pending.push(job)
      if (!this.queues.has(sourceId)) {
        this.queues.set(sourceId, pending)
        setTimeout(() => void this.drain(sourceId, pending), 0)
      }
    })
  }

  private async drain(sourceId: string, queue: PendingImage[]): Promise<void> {
    while (queue.length > 0) {
      const snapshot = queue[0]!.snapshot
      const jobs: PendingImage[] = []
      while (queue[0]?.snapshot === snapshot && jobs.length < IMAGE_BATCH_SIZE) {
        const job = queue.shift()!
        if (!job.signal.aborted) {
          jobs.push(job)
        }
      }
      if (jobs.length) {
        await this.readBatch(snapshot, jobs)
      }
    }
    this.queues.delete(sourceId)
  }

  private async readBatch(
    snapshot: PluginMarketplaceCachedSnapshot,
    jobs: PendingImage[]
  ): Promise<void> {
    const controller = new AbortController()
    const onAbort = () => {
      if (jobs.every((job) => job.signal.aborted)) {
        controller.abort()
      }
    }
    const paths = new Map<string, number>()
    for (const job of jobs) {
      job.signal.addEventListener('abort', onAbort, { once: true })
      paths.set(job.path, Math.max(paths.get(job.path) ?? 0, PLUGIN_IMAGE_RULES[job.kind].maxBytes))
    }
    try {
      const files = await this.options.repositories.readImages(
        snapshot.sourceId,
        snapshot.marketplaceCommit,
        paths,
        controller.signal,
        snapshotRepositorySlot(snapshot)
      )
      for (const job of jobs) {
        const bytes = files.get(job.path)
        if (job.signal.aborted || !bytes) {
          continue
        }
        const info = readPluginImageHeader(bytes)
        if (typeof info !== 'string' && validateCatalogImage(bytes, job.image, job.kind)) {
          await this.options.cache.put(bytes).catch(() => null)
          job.finish({ bytes, mimeType: PLUGIN_IMAGE_MIME[info.format] })
        }
      }
    } catch {
      // A failed local read can be retried by the next request.
    } finally {
      for (const job of jobs) {
        job.signal.removeEventListener('abort', onAbort)
        job.finish(null)
      }
    }
  }
}
