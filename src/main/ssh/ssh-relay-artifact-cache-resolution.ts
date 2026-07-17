import { isAbsolute } from 'node:path'

import {
  lookupSshRelayArtifactCacheEntry,
  type SshRelayArtifactCacheLookup
} from './ssh-relay-artifact-cache-entry'
import type { SshRelayArtifactCacheEntry } from './ssh-relay-artifact-cache-entry-verification'
import {
  acquireSshRelayArtifactCacheInUseLease,
  type SshRelayArtifactCacheInUseLease
} from './ssh-relay-artifact-cache-in-use-lease'
import {
  selectSshRelayArtifact,
  type SshRelayArtifactLegacyReason,
  type SshRelayHostEvidence,
  type SshRelaySelectedArtifact
} from './ssh-relay-artifact-selector'
import type { SshRelayOfficialManifest } from './ssh-relay-official-manifest'

export type SshRelayArtifactCacheResolutionOperations = Readonly<{
  lookup: typeof lookupSshRelayArtifactCacheEntry
  acquireInUseLease: typeof acquireSshRelayArtifactCacheInUseLease
}>

const DEFAULT_OPERATIONS: SshRelayArtifactCacheResolutionOperations = Object.freeze({
  lookup: lookupSshRelayArtifactCacheEntry,
  acquireInUseLease: acquireSshRelayArtifactCacheInUseLease
})

export type SshRelayArtifactCacheResolution =
  | Readonly<{ kind: 'unavailable'; reason: 'official-manifest-unavailable' }>
  | Readonly<{ kind: 'legacy'; reason: SshRelayArtifactLegacyReason }>
  | Readonly<{ kind: 'cache-miss'; artifact: SshRelaySelectedArtifact }>
  | Readonly<{
      kind: 'cache-hit'
      artifact: SshRelaySelectedArtifact
      entry: Readonly<SshRelayArtifactCacheEntry>
      lease: SshRelayArtifactCacheInUseLease
    }>

function frozenUnavailable(): SshRelayArtifactCacheResolution {
  return Object.freeze({ kind: 'unavailable', reason: 'official-manifest-unavailable' })
}

function frozenLegacy(reason: SshRelayArtifactLegacyReason): SshRelayArtifactCacheResolution {
  return Object.freeze({ kind: 'legacy', reason })
}

function frozenEntry(
  lookup: Extract<SshRelayArtifactCacheLookup, { kind: 'hit' }>
): Readonly<SshRelayArtifactCacheEntry> {
  return Object.freeze({ ...lookup.entry })
}

export async function resolveSshRelayArtifactCache(
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
  operations: SshRelayArtifactCacheResolutionOperations = DEFAULT_OPERATIONS
): Promise<SshRelayArtifactCacheResolution> {
  signal?.throwIfAborted()
  if (officialManifest === null) {
    return frozenUnavailable()
  }

  const selection = selectSshRelayArtifact(officialManifest.manifest, host)
  if (selection.kind === 'legacy') {
    return frozenLegacy(selection.reason)
  }
  if (typeof cacheRoot !== 'string' || !isAbsolute(cacheRoot)) {
    throw new Error('SSH relay artifact cache resolution root must be absolute')
  }

  signal?.throwIfAborted()
  // Why: integrity/quarantine errors intentionally escape this boundary and can never become misses.
  const lookup = await operations.lookup({ cacheRoot, artifact: selection, signal })
  signal?.throwIfAborted()
  if (lookup.kind === 'miss') {
    return Object.freeze({ kind: 'cache-miss', artifact: selection })
  }

  const entry = frozenEntry(lookup)
  const lease = await operations.acquireInUseLease({ cacheRoot, entry, signal })
  try {
    signal?.throwIfAborted()
    return Object.freeze({ kind: 'cache-hit', artifact: selection, entry, lease })
  } catch (error) {
    await lease.release().catch(() => {})
    throw error
  }
}
