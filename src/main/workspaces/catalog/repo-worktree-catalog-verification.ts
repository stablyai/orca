import type {
  WorktreeCatalogObservation,
  WorktreeCatalogVerifier
} from './repo-worktree-catalog-observation'

type Verification =
  | { reuse: true; provenAtWatchEpoch?: number | null }
  | { reuse: false; probe: Promise<string | null> | null }

/** Reuse when the watch saw no change, or a probe proves, or cannot yet disprove (#19312), that rows fingerprinted before their scan still hold. */
export async function verify(
  observation: WorktreeCatalogObservation,
  verifier: WorktreeCatalogVerifier,
  now: number
): Promise<Verification> {
  if (observation.outcome.kind !== 'rows' || now - observation.startedAt >= verifier.ceilingMs) {
    return { reuse: false, probe: null }
  }
  // Read before probing so a change during the probe cannot be stamped as already observed.
  const watchEpoch = verifier.watchEpoch?.() ?? null
  if (watchEpoch !== null && observation.catalogWatchEpoch === watchEpoch) {
    return { reuse: true }
  }
  // Without a fingerprint from before its scan, no probe can certify these rows.
  if (!observation.adminFingerprint) {
    return { reuse: false, probe: null }
  }
  const probe = verifier.probe()
  if (probe === 'in-flight') {
    verifier.onUnknown?.('previous probe still pending')
    return { reuse: true }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), verifier.timeoutMs)
  })
  const current = await Promise.race([probe, timeout]).finally(() => clearTimeout(timer))
  if (current === 'timeout') {
    // Unknown is not proof, but rescanning slow mounts on every read amplifies load (#19312).
    verifier.onUnknown?.('probe expired')
    return { reuse: true }
  }
  // A mismatching probe was taken before the rescan, so it becomes that scan's fingerprint.
  return current !== null && (await observation.adminFingerprint) === current
    ? { reuse: true, provenAtWatchEpoch: watchEpoch }
    : { reuse: false, probe }
}
