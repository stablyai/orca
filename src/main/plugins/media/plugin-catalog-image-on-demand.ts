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
  type CatalogRepositorySlot,
  type PluginMarketplaceCachedSnapshot,
  type PluginMarketplaceRegisteredSource,
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
  controller: AbortController
  subscribers: Set<(asset: CheckedPluginImage | null) => void>
}

function imageKey(
  kind: PluginImageKind,
  image: Pick<CatalogImage, 'path' | 'sha256' | 'width' | 'height'>
): string {
  return JSON.stringify([image.path, image.sha256, kind, image.width, image.height])
}

export class PluginCatalogImageOnDemand {
  private readonly locations = new WeakMap<PluginMarketplaceCachedSnapshot, Set<string>>()
  private readonly verified = new WeakMap<
    PluginMarketplaceRegisteredSource,
    { commit: string; slot: CatalogRepositorySlot; keys: Set<string> }
  >()
  private readonly pending = new WeakMap<
    PluginMarketplaceCachedSnapshot,
    Map<string, PendingImage>
  >()
  private readonly queues = new Map<string, PendingImage[]>()

  constructor(
    private readonly options: {
      cache: PluginImageCache
      store: Pick<PluginMarketplaceStore, 'listSources' | 'readSnapshot'>
      repositories: Pick<PluginCatalogRepositoryStore, 'readImages'>
    }
  ) {}

  async read(reference: CatalogReference, signal: AbortSignal): Promise<CheckedPluginImage | null> {
    const { sourceId, path } = reference.location
    const source = (await this.options.store.listSources()).find((entry) => entry.id === sourceId)
    if (signal.aborted || !source) {
      return null
    }
    const snapshot = await this.options.store.readSnapshot(sourceId)
    if (signal.aborted || !snapshot) {
      return null
    }
    const image = { ...reference.image, path, sha256: reference.sha256 }
    const key = imageKey(image.kind, image)
    const asset = await this.readFromSnapshot(source, snapshot, key, image, signal)
    if (asset || signal.aborted) {
      return asset
    }
    // A queued read can reach Git after a concurrent publication has retired its snapshot.
    const current = await this.options.store.readSnapshot(sourceId)
    if (signal.aborted || !current || current === snapshot) {
      return null
    }
    return this.readFromSnapshot(source, current, key, image, signal)
  }

  private async readFromSnapshot(
    source: PluginMarketplaceRegisteredSource,
    snapshot: PluginMarketplaceCachedSnapshot,
    key: string,
    image: CatalogReference['image'] & Pick<CatalogImage, 'path' | 'sha256'>,
    signal: AbortSignal
  ): Promise<CheckedPluginImage | null> {
    const locations = this.locations.get(snapshot) ?? this.indexSnapshot(snapshot)
    if (!locations.has(key)) {
      return null
    }
    const commit = snapshot.marketplaceCommit
    const slot = snapshotRepositorySlot(snapshot)
    let verified = this.verified.get(source)
    if (verified?.commit !== commit || verified.slot !== slot) {
      verified = { commit, slot, keys: new Set() }
      this.verified.set(source, verified)
    }
    if (verified.keys.has(key)) {
      const cached = await this.options.cache.get(image.sha256).catch(() => null)
      if (cached) {
        return cached
      }
    }
    const asset = await this.queue(
      { snapshot, path: image.path, kind: image.kind, image },
      key,
      signal
    )
    if (asset) {
      verified.keys.add(key)
    }
    return asset
  }

  private indexSnapshot(snapshot: PluginMarketplaceCachedSnapshot): Set<string> {
    const locations = new Set<string>()
    const add = (kind: PluginImageKind, image: CatalogImage | undefined): void => {
      if (image) {
        locations.add(imageKey(kind, image))
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

  private queue(
    input: Omit<PendingImage, 'controller' | 'subscribers'>,
    key: string,
    signal: AbortSignal
  ): Promise<CheckedPluginImage | null> {
    if (signal.aborted) {
      return Promise.resolve(null)
    }
    const { snapshot } = input
    const { sourceId } = snapshot
    const pending = this.pending.get(snapshot) ?? new Map<string, PendingImage>()
    let job = pending.get(key)
    if (!job) {
      const subscribers = new Set<(asset: CheckedPluginImage | null) => void>()
      job = { ...input, controller: new AbortController(), subscribers }
      pending.set(key, job)
      this.pending.set(snapshot, pending)
      const queue = this.queues.get(sourceId) ?? []
      queue.push(job)
      if (!this.queues.has(sourceId)) {
        this.queues.set(sourceId, queue)
        setTimeout(() => void this.drain(sourceId, queue), 0)
      }
    }
    const { subscribers, controller } = job
    return new Promise((resolve) => {
      const onAbort = () => {
        finish(null)
        if (subscribers.size === 0) {
          controller.abort()
        }
      }
      const finish = (asset: CheckedPluginImage | null) => {
        signal.removeEventListener('abort', onAbort)
        subscribers.delete(finish)
        if (subscribers.size === 0 && pending.get(key) === job) {
          pending.delete(key)
        }
        resolve(asset)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      subscribers.add(finish)
    })
  }

  private async drain(sourceId: string, queue: PendingImage[]): Promise<void> {
    while (queue.length > 0) {
      const snapshot = queue[0]!.snapshot
      const jobs: PendingImage[] = []
      while (queue[0]?.snapshot === snapshot && jobs.length < IMAGE_BATCH_SIZE) {
        const job = queue.shift()!
        if (!job.controller.signal.aborted) {
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
      if (jobs.every((job) => job.controller.signal.aborted)) {
        controller.abort()
      }
    }
    const paths = new Map<string, number>()
    for (const job of jobs) {
      job.controller.signal.addEventListener('abort', onAbort, { once: true })
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
        if (job.controller.signal.aborted || !bytes) {
          continue
        }
        const info = readPluginImageHeader(bytes)
        if (typeof info !== 'string' && validateCatalogImage(bytes, job.image, job.kind)) {
          await this.options.cache.put(bytes).catch(() => null)
          for (const finish of job.subscribers) {
            finish({ bytes, mimeType: PLUGIN_IMAGE_MIME[info.format] })
          }
        }
      }
    } catch {
      // A failed local read can be retried by the next request.
    } finally {
      for (const job of jobs) {
        job.controller.signal.removeEventListener('abort', onAbort)
        for (const finish of job.subscribers) {
          finish(null)
        }
      }
    }
  }
}
