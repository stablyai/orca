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
import { CatalogSnapshotImages, catalogImageKey, gitBlobId } from './plugin-catalog-snapshot-images'
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

type Verified = {
  commit: string
  slot: CatalogRepositorySlot
  keys: Set<string>
  writing: Map<string, CheckedPluginImage>
}

export class PluginCatalogImageOnDemand {
  private readonly verified = new WeakMap<PluginMarketplaceRegisteredSource, Verified>()
  private readonly snapshots: CatalogSnapshotImages
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
      repositories: Pick<PluginCatalogRepositoryStore, 'readImages' | 'listImages'>
    }
  ) {
    this.snapshots = new CatalogSnapshotImages((snapshot, paths) =>
      options.repositories.listImages(snapshot.sourceId, () => {
        const source = options.policy.findEffectiveSource(options.store, snapshot.sourceId)
        return source && this.currentSnapshot(source) === snapshot
          ? {
              commit: snapshot.marketplaceCommit,
              paths,
              slot: snapshotRepositorySlot(snapshot)
            }
          : null
      })
    )
  }

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
    const key = catalogImageKey(image.kind, image)
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
    return this.snapshots.declares(snapshot, key)
  }

  private verifiedAt(
    source: PluginMarketplaceRegisteredSource,
    snapshot: PluginMarketplaceCachedSnapshot
  ): Verified {
    const commit = snapshot.marketplaceCommit
    const slot = snapshotRepositorySlot(snapshot)
    let verified = this.verified.get(source)
    if (verified?.commit !== commit || verified.slot !== slot) {
      verified = { commit, slot, keys: new Set(), writing: new Map() }
      this.verified.set(source, verified)
    }
    return verified
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
      const cached =
        verified.writing.get(key) ?? (await this.options.cache.get(image.sha256).catch(() => null))
      if (cached) {
        return cached
      }
    }
    // Why: after a restart or a new commit, bytes already cached under the declared hash are
    // proven by the commit's listed blob id, which costs one shared listing instead of a read.
    const [cached, listed] = await Promise.all([
      this.options.cache.get(image.sha256).catch(() => null),
      this.snapshots.listing(snapshot)
    ])
    const entry = listed?.get(image.path)
    if (
      cached &&
      entry &&
      !signal.aborted &&
      entry.object === gitBlobId(cached.bytes) &&
      validateCatalogImage(cached.bytes, image, image.kind)
    ) {
      this.verifiedAt(source, snapshot).keys.add(key)
      return cached
    }
    return this.queue({ source, snapshot, key, path: image.path, kind: image.kind, image }, signal)
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
    const cacheWrites: Promise<unknown>[] = []
    const onAbort = () => {
      if (jobs.every((job) => job.controller.signal.aborted)) {
        controller.abort()
      }
    }
    for (const job of jobs) {
      job.controller.signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      let admitted: {
        job: PendingImage
        snapshot: PluginMarketplaceCachedSnapshot
      }[] = []
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
            ? {
                commit: snapshot.marketplaceCommit,
                paths,
                slot: snapshotRepositorySlot(snapshot),
                listed: this.snapshots.listed(snapshot)
              }
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
          const asset = { bytes, mimeType: PLUGIN_IMAGE_MIME[info.format] }
          const verified = this.verifiedAt(job.source, snapshot)
          verified.keys.add(job.key)
          const { writing } = verified
          writing.set(job.key, asset)
          cacheWrites.push(
            this.options.cache
              .put(bytes)
              .catch(() => null)
              .finally(() => writing.delete(job.key))
          )
          for (const finish of job.subscribers) {
            finish(asset)
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
      // Keep the batch's bytes bounded while the disk cache catches up with delivery.
      await Promise.all(cacheWrites)
    }
  }
}
