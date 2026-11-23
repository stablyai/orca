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
import type { PluginMarketplaceTeamPolicy } from '../catalog/plugin-marketplace-team-policy'
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
  source: PluginMarketplaceRegisteredSource
  snapshot: PluginMarketplaceCachedSnapshot
  key: string
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
      policy: PluginMarketplaceTeamPolicy
      cache: PluginImageCache
      store: PluginMarketplaceStore
      repositories: Pick<PluginCatalogRepositoryStore, 'readImages'>
    }
  ) {}

  async read(reference: CatalogReference, signal: AbortSignal): Promise<CheckedPluginImage | null> {
    const { sourceId, path } = reference.location
    const { store, policy } = this.options
    const source = await policy.loadEffectiveSource(store, sourceId)
    if (signal.aborted || !source) {
      return null
    }
    await store.readSnapshot(sourceId)
    const snapshot = this.currentSnapshot(source)
    if (signal.aborted || !snapshot) {
      return null
    }
    const image = { ...reference.image, path, sha256: reference.sha256 }
    const key = imageKey(image.kind, image)
    const asset = await this.readFromSnapshot(source, snapshot, key, image, signal)
    if (signal.aborted || asset) {
      return !signal.aborted && this.isEffective(source) ? asset : null
    }
    const current = this.currentSnapshot(source)
    if (!current || current === snapshot) {
      return null
    }
    const retried = await this.readFromSnapshot(source, current, key, image, signal)
    return this.isEffective(source) && !signal.aborted ? retried : null
  }

  private isEffective(source: PluginMarketplaceRegisteredSource): boolean {
    return this.options.policy.findEffectiveSource(this.options.store, source.id) === source
  }

  private currentSnapshot(source: PluginMarketplaceRegisteredSource) {
    const snapshot = this.options.store.currentSnapshot(source.id)
    return this.isEffective(source) &&
      snapshot?.source.url === source.source.url &&
      snapshot.source.ref === source.source.ref
      ? snapshot
      : null
  }

  private declares(snapshot: PluginMarketplaceCachedSnapshot, key: string): boolean {
    return (this.locations.get(snapshot) ?? this.indexSnapshot(snapshot)).has(key)
  }

  private async readFromSnapshot(
    source: PluginMarketplaceRegisteredSource,
    snapshot: PluginMarketplaceCachedSnapshot,
    key: string,
    image: CatalogReference['image'] & Pick<CatalogImage, 'path' | 'sha256'>,
    signal: AbortSignal
  ): Promise<CheckedPluginImage | null> {
    if (!this.declares(snapshot, key)) {
      return null
    }
    const commit = snapshot.marketplaceCommit
    const slot = snapshotRepositorySlot(snapshot)
    const verified = this.verified.get(source)
    if (verified?.commit === commit && verified.slot === slot && verified.keys.has(key)) {
      const cached = await this.options.cache.get(image.sha256).catch(() => null)
      if (cached) {
        return cached
      }
    }
    return this.queue({ source, snapshot, key, path: image.path, kind: image.kind, image }, signal)
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
    signal: AbortSignal
  ): Promise<CheckedPluginImage | null> {
    if (signal.aborted) {
      return Promise.resolve(null)
    }
    const { snapshot, key } = input
    const { sourceId } = snapshot
    const pending = this.pending.get(snapshot) ?? new Map<string, PendingImage>()
    let job = pending.get(key)
    if (job?.source !== input.source) {
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
        await this.readBatch(sourceId, jobs)
      }
    }
    this.queues.delete(sourceId)
  }

  private async readBatch(sourceId: string, jobs: PendingImage[]): Promise<void> {
    const controller = new AbortController()
    const onAbort = () => {
      if (jobs.every((job) => job.controller.signal.aborted)) {
        controller.abort()
      }
    }
    for (const job of jobs) {
      job.controller.signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      let admitted: { job: PendingImage; snapshot: PluginMarketplaceCachedSnapshot }[] = []
      const files = await this.options.repositories.readImages(
        sourceId,
        () => {
          const paths = new Map<string, number>()
          admitted = jobs.flatMap((job) => {
            const snapshot = this.currentSnapshot(job.source)
            if (!snapshot || job.controller.signal.aborted || !this.declares(snapshot, job.key)) {
              return []
            }
            paths.set(
              job.path,
              Math.max(paths.get(job.path) ?? 0, PLUGIN_IMAGE_RULES[job.kind].maxBytes)
            )
            return [{ job, snapshot }]
          })
          const snapshot = admitted[0]?.snapshot
          return snapshot
            ? { commit: snapshot.marketplaceCommit, paths, slot: snapshotRepositorySlot(snapshot) }
            : null
        },
        controller.signal
      )
      for (const { job, snapshot } of admitted) {
        const bytes = files.get(job.path)
        if (job.controller.signal.aborted || !bytes) {
          continue
        }
        const info = readPluginImageHeader(bytes)
        if (typeof info !== 'string' && validateCatalogImage(bytes, job.image, job.kind)) {
          await this.options.cache.put(bytes).catch(() => null)
          const commit = snapshot.marketplaceCommit
          const slot = snapshotRepositorySlot(snapshot)
          let verified = this.verified.get(job.source)
          if (verified?.commit !== commit || verified.slot !== slot) {
            verified = { commit, slot, keys: new Set() }
            this.verified.set(job.source, verified)
          }
          verified.keys.add(job.key)
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
