import { MobileWebBundleManifestReadSchema } from '../transport/web-bundle/mobile-web-bundle-reply-schemas'
import { joinUri } from './generation-cache-uri'
import { MANIFEST_FILE_NAME } from './generation-asset-path'
import { isHostCacheKey } from './host-cache-key'
import type { ActiveGeneration, GenerationLease, StagedGeneration } from './generation-store'
import type { GenerationFileSystem } from './generation-store-file-system'
import {
  appendGenerationSelection,
  compactGenerationSelections,
  readGenerationSelections,
  type GenerationSelectionLog
} from './generation-selection'

type LeaseOwner = {
  readonly hostKey: string
  readonly activationRevision: number | undefined
  readonly lease: GenerationLease
  readonly hostEpoch: number
}

export function createGenerationActivation(fs: GenerationFileSystem) {
  const leaseOwners = new WeakMap<GenerationLease, LeaseOwner>()
  const live = new Set<LeaseOwner>()
  const publishedRevisions = new Map<string, number>()
  const hostEpochs = new Map<string, number>()
  const hostRoot = (hostKey: string): string => {
    if (!isHostCacheKey(hostKey)) {
      throw new Error('generation store was handed something that is not a host cache key')
    }
    return joinUri(fs.rootUri, hostKey)
  }
  const generationsRoot = (hostKey: string): string => joinUri(hostRoot(hostKey), 'generations')
  async function readGeneration(
    hostKey: string,
    buildId: string
  ): Promise<ActiveGeneration | null> {
    if (!isHostCacheKey(buildId)) {
      return null
    }
    const directory = joinUri(generationsRoot(hostKey), buildId)
    const text = await fs.readText(joinUri(directory, MANIFEST_FILE_NAME))
    const manifest = text === null ? null : parseManifest(text)
    return manifest?.buildId === buildId ? { buildId, directory, manifest } : null
  }

  async function legacyGeneration(hostKey: string): Promise<ActiveGeneration | null> {
    const directories = (await fs.list(generationsRoot(hostKey))).filter(
      (entry) => entry.isDirectory
    )
    return directories.length === 1 ? readGeneration(hostKey, directories[0].name) : null
  }

  async function migratedLegacyGeneration(hostKey: string): Promise<ActiveGeneration | null> {
    const buildId = await fs.readText(joinUri(hostRoot(hostKey), 'legacy-selection'))
    return buildId === null ? null : readGeneration(hostKey, buildId)
  }

  async function selectionLog(hostKey: string): Promise<GenerationSelectionLog> {
    const log = await readGenerationSelections(fs, hostRoot(hostKey))
    if (log.records.length > 0) {
      return log
    }
    // Record the inherited legacy identity before creating a journal that could tear on its first write.
    const legacy = log.exists
      ? await migratedLegacyGeneration(hostKey)
      : await legacyGeneration(hostKey)
    if (!log.exists && legacy !== null) {
      await fs.writeText(joinUri(hostRoot(hostKey), 'legacy-selection'), legacy.buildId)
    }
    const record = await appendGenerationSelection(fs, hostRoot(hostKey), log, {
      confirmed: legacy?.buildId ?? null,
      pending: null,
      rejected: null
    })
    return { records: [record], nextRevision: record.revision + 1, exists: true }
  }

  async function readActive(hostKey: string): Promise<ActiveGeneration | null> {
    try {
      const log = await readGenerationSelections(fs, hostRoot(hostKey))
      if (log.exists) {
        if (log.records.length === 0) {
          return migratedLegacyGeneration(hostKey)
        }
        for (const selection of log.records) {
          if (selection.confirmed === null) {
            return null
          }
          const active = await readGeneration(hostKey, selection.confirmed)
          if (active !== null) {
            return active
          }
        }
        return null
      }
      const legacy = await legacyGeneration(hostKey)
      if (legacy !== null) {
        return legacy
      }
      return null
    } catch {
      // Unreadable is not corrupt: leave authority and verified bytes intact.
      return null
    }
  }

  async function cleanGenerations(hostKey: string): Promise<void> {
    const log = await readGenerationSelections(fs, hostRoot(hostKey))
    if (log.records.length === 0) {
      return
    }
    const kept = new Set([
      ...log.records.slice(0, 2).map((record) => record.confirmed),
      log.records[0].pending,
      ...[...live]
        .filter((owner) => owner.hostKey === hostKey)
        .map((owner) => owner.lease.generation.buildId)
    ])
    await compactGenerationSelections(fs, hostRoot(hostKey), log.records)
    for (const entry of await fs.list(generationsRoot(hostKey))) {
      if (!kept.has(entry.name)) {
        await fs.delete(joinUri(generationsRoot(hostKey), entry.name))
      }
    }
  }
  async function commit(staged: StagedGeneration): Promise<ActiveGeneration> {
    const generations = generationsRoot(staged.hostKey)
    const target = joinUri(generations, staged.buildId)
    const log = await selectionLog(staged.hostKey)
    const selection = log.records[0]
    if (selection === undefined) {
      throw new Error('generation selection is unreadable')
    }
    if (selection.rejected === staged.buildId) {
      throw new Error('generation previously failed to boot')
    }
    // The on-disk manifest owns metadata even when the asset digest matches a new offer.
    const existing = await readGeneration(staged.hostKey, staged.buildId)
    if (existing !== null) {
      await fs.delete(staged.directory)
    } else {
      if (!(await fs.fileExists(joinUri(staged.directory, MANIFEST_FILE_NAME)))) {
        throw new Error(`staged generation ${staged.buildId} is no longer on disk`)
      }
      if ([...live].some((owner) => owner.lease.generation.directory === target)) {
        throw new Error('cannot replace a live generation')
      }
      await fs.delete(target)
      await fs.createDirectory(generations)
      await fs.moveDirectory(staged.directory, target)
    }
    const installed = existing ?? (await readGeneration(staged.hostKey, staged.buildId))
    if (installed === null) {
      throw new Error(`generation ${staged.buildId} did not carry its manifest through the rename`)
    }
    // Some native moves copy trees rather than atomically renaming; refuse partial destinations.
    for (const asset of installed.manifest.assets) {
      if ((await fs.fileSize(joinUri(target, asset.path))) !== asset.byteLength) {
        throw new Error(`generation ${staged.buildId} did not carry asset ${asset.path}`)
      }
    }
    if (selection.confirmed === staged.buildId) {
      return installed
    }
    if (selection.pending === staged.buildId) {
      if (publishedRevisions.get(staged.hostKey) !== selection.revision) {
        throw new Error('generation was not confirmed before restart')
      }
      return { ...installed, activationRevision: selection.revision }
    }
    const published = await appendGenerationSelection(fs, hostRoot(staged.hostKey), log, {
      confirmed: selection.confirmed,
      pending: staged.buildId,
      rejected: selection.rejected
    })
    publishedRevisions.set(staged.hostKey, published.revision)
    await cleanGenerations(staged.hostKey).catch(() => undefined)
    return { ...installed, activationRevision: published.revision }
  }

  async function acquire(
    hostKey: string,
    generation: Pick<ActiveGeneration, 'buildId' | 'activationRevision'>
  ): Promise<GenerationLease | null> {
    const log = await selectionLog(hostKey)
    const selection = log.records[0]
    const confirmed = (await readActive(hostKey))?.buildId === generation.buildId
    const pending =
      selection?.pending === generation.buildId &&
      selection.revision === generation.activationRevision
    if (!confirmed && !pending) {
      return null
    }
    const installed = await readGeneration(hostKey, generation.buildId)
    if (installed === null) {
      return null
    }
    const lease: GenerationLease = {
      generation: { ...installed, activationRevision: generation.activationRevision }
    }
    const owner = {
      hostKey,
      activationRevision: pending ? selection.revision : undefined,
      lease,
      hostEpoch: hostEpochs.get(hostKey) ?? 0
    }
    live.add(owner)
    leaseOwners.set(lease, owner)
    return lease
  }

  async function confirm(lease: GenerationLease, isCurrentDocument: () => boolean): Promise<void> {
    const owner = leaseOwners.get(lease)
    if (
      owner === undefined ||
      !live.has(owner) ||
      owner.hostEpoch !== (hostEpochs.get(owner.hostKey) ?? 0) ||
      !isCurrentDocument()
    ) {
      return
    }
    const log = await selectionLog(owner.hostKey)
    const selection = log.records[0]
    if (
      selection?.pending !== lease.generation.buildId ||
      selection.revision !== owner.activationRevision
    ) {
      return
    }
    if (
      !live.has(owner) ||
      owner.hostEpoch !== (hostEpochs.get(owner.hostKey) ?? 0) ||
      !isCurrentDocument()
    ) {
      return
    }
    await appendGenerationSelection(fs, hostRoot(owner.hostKey), log, {
      confirmed: lease.generation.buildId,
      pending: null,
      rejected: null
    })
    await cleanGenerations(owner.hostKey).catch(() => undefined)
  }

  async function reject(lease: GenerationLease): Promise<void> {
    const owner = leaseOwners.get(lease)
    if (owner === undefined || owner.hostEpoch !== (hostEpochs.get(owner.hostKey) ?? 0)) {
      return
    }
    const log = await selectionLog(owner.hostKey)
    const selection = log.records[0]
    if (selection === undefined) {
      return
    }
    const buildId = lease.generation.buildId
    const pending = selection.pending === buildId && selection.revision === owner.activationRevision
    const attempt = log.records[1]
    // Only the boot attempt that earned confirmation may revoke it.
    const confirmed =
      selection.confirmed === buildId &&
      selection.pending === null &&
      attempt?.pending === buildId &&
      attempt.revision === owner.activationRevision
    if (!pending && !confirmed) {
      return
    }
    await appendGenerationSelection(fs, hostRoot(owner.hostKey), log, {
      confirmed: confirmed
        ? (log.records.find((record) => record.confirmed !== null && record.confirmed !== buildId)
            ?.confirmed ?? null)
        : selection.confirmed,
      pending: null,
      rejected: buildId
    })
    await cleanGenerations(owner.hostKey).catch(() => undefined)
  }

  return {
    readActive,
    cleanGenerations,
    commit,
    acquire,
    confirm,
    reject,
    hasLive: (hostKey: string) => [...live].some((owner) => owner.hostKey === hostKey),
    release(lease: GenerationLease): void {
      const owner = leaseOwners.get(lease)
      if (owner !== undefined) {
        live.delete(owner)
      }
    },
    revokeHost(hostKey: string): void {
      publishedRevisions.delete(hostKey)
      hostEpochs.set(hostKey, (hostEpochs.get(hostKey) ?? 0) + 1)
      for (const owner of live) {
        if (owner.hostKey === hostKey) {
          live.delete(owner)
        }
      }
    }
  }
}

function parseManifest(text: string) {
  try {
    const parsed = MobileWebBundleManifestReadSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
