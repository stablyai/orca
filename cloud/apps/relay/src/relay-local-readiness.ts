import type { RelayReadinessDependency } from './relay-readiness.js'

export type RelayLocalReadinessVerdict =
  | { ready: true; failing: RelayReadinessDependency[] }
  | { ready: false; reason: 'not_listening' | 'keys_not_loaded' }

// `readinessLocal`: the load balancer keeps a cell that can still serve its connected hosts and
// verify new tokens from cached keys, so a database or auth outage costs a per-hello refusal
// instead of the whole hostname. The heartbeat keeps the SQL verdict, so directors still stop
// placing here.
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
