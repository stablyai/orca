import type { RelayReadinessDependency } from './relay-readiness.js'

export type RelayLocalReadinessVerdict =
  | { ready: true; failing: RelayReadinessDependency[] }
  | { ready: false; reason: 'not_listening' | 'keys_not_loaded' }

// Keep cells serving connected hosts/cached-key auth through dependency outages; SQL heartbeats still stop director placement.
export function createRelayLocalReadiness(input: {
  listening: () => boolean
  // The host token verifier's own key set: a fetch by any other client proves nothing about it.
  keys: { jwks: () => unknown; reload: () => Promise<void> }
  failingDependencies: () => RelayReadinessDependency[]
}): () => RelayLocalReadinessVerdict {
  let loading: Promise<void> | null = null
  return () => {
    if (!input.listening()) return { ready: false, reason: 'not_listening' }
    if (input.keys.jwks() === undefined) {
      // Keys load lazily on the first hello, which a cell outside rotation never gets.
      loading ??= input.keys
        .reload()
        .catch(() => undefined)
        .finally(() => {
          loading = null
        })
      return { ready: false, reason: 'keys_not_loaded' }
    }
    return { ready: true, failing: input.failingDependencies() }
  }
}
