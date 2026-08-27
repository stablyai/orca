import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { getAppEnvironment } from '../../../../shared/app-environment'
import type { RouteEvidence } from './route-certification-evidence'

/** Correction — the runtime's own build identity, and the candidate commit SHA
 *  that identity is pinned to.
 *
 *  `buildHash` is the content hash of the entry file this process is executing,
 *  so it changes whenever the built code changes and cannot be asserted by a
 *  caller. Evidence records `version+buildHash`, which is what makes evidence
 *  from runtime A immediately stale on runtime B.
 *
 *  The commit SHA is declared by the certification run, not knowable from the
 *  process — so the runtime PINS it: the SHA carried by this build's own
 *  evidence. Two different SHAs claiming the same build is a contradiction, and
 *  the resolver fails closed by pinning a sentinel nothing can match.
 */

const CONTRADICTED = 'contradicted'

export type RuntimeBuildIdentity = {
  version: string
  buildHash: string
  /** The value written to and compared against `RouteEvidence.runtimeVersion`. */
  id: string
}

export function computeRuntimeBuildHash(entryPath = process.argv[1]): string {
  if (!entryPath) {
    return 'unknown'
  }
  try {
    return createHash('sha256').update(readFileSync(entryPath)).digest('hex').slice(0, 16)
  } catch {
    return 'unknown'
  }
}

export function resolveRuntimeBuildIdentity(entryPath = process.argv[1]): RuntimeBuildIdentity {
  // Why tolerate a missing environment: this is read on the admission path, and
  // a host that has not installed an AppEnvironment must still get a usable
  // identity rather than an exception. The build hash carries the real signal.
  let version: string
  try {
    version = getAppEnvironment().getVersion()
  } catch {
    version = 'unknown'
  }
  const buildHash = computeRuntimeBuildHash(entryPath)
  return { version, buildHash, id: `${version}+${buildHash}` }
}

/** The commit SHA this runtime build is pinned to, read from the build's own
 *  evidence. Null when the build has recorded none yet; `contradicted` when its
 *  rows disagree, which no evidence can then match. */
export function resolveCandidateCommitSha(
  evidence: readonly RouteEvidence[],
  buildId: string
): string | null {
  const shas = new Set(
    evidence.filter((row) => row.runtimeVersion === buildId).map((row) => row.commitSha)
  )
  if (shas.size === 0) {
    return null
  }
  if (shas.size > 1) {
    return CONTRADICTED
  }
  return [...shas][0] as string
}
