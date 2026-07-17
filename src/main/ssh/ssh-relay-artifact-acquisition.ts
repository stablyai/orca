import type { SshRelayArtifactCacheEntry } from './ssh-relay-artifact-cache-entry-verification'
import type { SshRelayArtifactCacheInUseLease } from './ssh-relay-artifact-cache-in-use-lease'
import {
  populateSshRelayArtifactCache,
  type SshRelayArtifactCachePopulation
} from './ssh-relay-artifact-cache-population'
import { resolveSshRelayArtifactCache } from './ssh-relay-artifact-cache-resolution'
import type {
  SshRelayArtifactLegacyReason,
  SshRelayHostEvidence,
  SshRelaySelectedArtifact
} from './ssh-relay-artifact-selector'
import type { SshRelayOfficialManifest } from './ssh-relay-official-manifest'

export type SshRelayArtifactAcquisitionOperations = Readonly<{
  resolve: typeof resolveSshRelayArtifactCache
  populate: typeof populateSshRelayArtifactCache
}>

const DEFAULT_OPERATIONS: SshRelayArtifactAcquisitionOperations = Object.freeze({
  resolve: resolveSshRelayArtifactCache,
  populate: populateSshRelayArtifactCache
})

export type SshRelayArtifactReadyAcquisition = Readonly<{
  kind: 'ready'
  source: 'cache' | 'download'
  artifact: SshRelaySelectedArtifact
  entry: Readonly<SshRelayArtifactCacheEntry>
  lease: SshRelayArtifactCacheInUseLease
}>

export type SshRelayArtifactAcquisition =
  | Readonly<{ kind: 'unavailable'; reason: 'official-manifest-unavailable' }>
  | Readonly<{ kind: 'legacy'; reason: SshRelayArtifactLegacyReason }>
  | SshRelayArtifactReadyAcquisition

function sameArtifactIdentity(
  expected: SshRelaySelectedArtifact,
  actual: SshRelaySelectedArtifact
): boolean {
  return (
    actual.tupleId === expected.tupleId &&
    actual.contentId === expected.contentId &&
    actual.releaseTag === expected.releaseTag &&
    actual.archive.name === expected.archive.name &&
    actual.archive.sha256 === expected.archive.sha256
  )
}

function sameEntryIdentity(
  artifact: SshRelaySelectedArtifact,
  entry: SshRelayArtifactCacheEntry
): boolean {
  return entry.tupleId === artifact.tupleId && entry.contentId === artifact.contentId
}

async function readyResult({
  source,
  expectedArtifact,
  actualArtifact,
  entry,
  lease,
  signal
}: {
  source: 'cache' | 'download'
  expectedArtifact: SshRelaySelectedArtifact
  actualArtifact: SshRelaySelectedArtifact
  entry: SshRelayArtifactCacheEntry
  lease: SshRelayArtifactCacheInUseLease
  signal?: AbortSignal
}): Promise<SshRelayArtifactAcquisition> {
  try {
    signal?.throwIfAborted()
    if (
      !sameArtifactIdentity(expectedArtifact, actualArtifact) ||
      !sameEntryIdentity(expectedArtifact, entry)
    ) {
      throw new Error('SSH relay artifact acquisition identity is inconsistent')
    }
    return Object.freeze({
      kind: 'ready',
      source,
      artifact: expectedArtifact,
      entry: Object.freeze({ ...entry }),
      lease
    })
  } catch (error) {
    await lease.release().catch(() => {})
    throw error
  }
}

function unavailableResult(): SshRelayArtifactAcquisition {
  return Object.freeze({ kind: 'unavailable', reason: 'official-manifest-unavailable' })
}

function legacyResult(reason: SshRelayArtifactLegacyReason): SshRelayArtifactAcquisition {
  return Object.freeze({ kind: 'legacy', reason })
}

export async function acquireSshRelayArtifact(
  {
    officialManifest,
    host,
    cacheRoot,
    signal
  }: {
    officialManifest: SshRelayOfficialManifest | null
    host: SshRelayHostEvidence
    cacheRoot: string
    signal?: AbortSignal
  },
  operations: SshRelayArtifactAcquisitionOperations = DEFAULT_OPERATIONS
): Promise<SshRelayArtifactAcquisition> {
  signal?.throwIfAborted()
  const resolution = await operations.resolve({ officialManifest, host, cacheRoot, signal })

  if (resolution.kind === 'unavailable') {
    signal?.throwIfAborted()
    return unavailableResult()
  }
  if (resolution.kind === 'legacy') {
    signal?.throwIfAborted()
    return legacyResult(resolution.reason)
  }
  if (resolution.kind === 'cache-hit') {
    return readyResult({
      source: 'cache',
      expectedArtifact: resolution.artifact,
      actualArtifact: resolution.artifact,
      entry: resolution.entry,
      lease: resolution.lease,
      signal
    })
  }

  signal?.throwIfAborted()
  // Why: availability and integrity classification belongs to the later fallback state machine.
  const populated: SshRelayArtifactCachePopulation = await operations.populate({
    cacheRoot,
    artifact: resolution.artifact,
    signal
  })
  return readyResult({
    source: 'download',
    expectedArtifact: resolution.artifact,
    actualArtifact: populated.artifact,
    entry: populated.entry,
    lease: populated.lease,
    signal
  })
}
