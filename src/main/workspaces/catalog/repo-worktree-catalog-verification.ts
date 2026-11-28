import type {
  WorktreeAdminProbeResult,
  WorktreeCatalogObservation,
  WorktreeCatalogVerifier
} from './repo-worktree-catalog-observation'

type Verification =
  | { reuse: true }
  | { reuse: false; probe: Promise<WorktreeAdminProbeResult> | null }

/** Reuse when a probe proves, or cannot yet disprove (#19312), that rows fingerprinted before their scan still hold. */
export async function verify(
  observation: WorktreeCatalogObservation,
  verifier: WorktreeCatalogVerifier,
  now: number
): Promise<Verification> {
  // Without a fingerprint from before its scan, no probe can certify these rows.
  if (
    observation.outcome.kind !== 'rows' ||
    !observation.adminFingerprint ||
    now - observation.startedAt >= verifier.ceilingMs
  ) {
    return { reuse: false, probe: null }
  }
  const probe = verifier.probe()
  const current = await probe
  if (current === 'timeout') {
    // Unknown is not proof, but rescanning slow mounts on every read amplifies load (#19312).
    verifier.onUnknown?.('probe expired')
    return { reuse: true }
  }
  // A mismatching probe settled before the rescan, so it becomes that scan's fingerprint.
  return current.fingerprint !== null && observation.adminFingerprint === current.fingerprint
    ? { reuse: true }
    : { reuse: false, probe }
}
