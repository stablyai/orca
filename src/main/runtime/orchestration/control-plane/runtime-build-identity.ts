import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { gitExecFileSync } from '../../../git/runner'
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

/** Where the runtime's source identity came from. `embedded` is the only kind
 *  that describes the ARTIFACT; `checkout` describes the working tree the
 *  process happens to sit in and moves when someone checks out another commit. */
export type BuildProvenanceSource = 'embedded' | 'checkout' | 'unknown'

export type EmbeddedBuildProvenance = {
  schemaVersion: number
  sourceSha: string | null
  dirty: boolean | null
  appVersion: string
  builtAt: string
}

/** The build-time literal, when this bundle carries one. */
export function readEmbeddedBuildProvenance(): EmbeddedBuildProvenance | null {
  const raw =
    typeof ORCA_BUILD_PROVENANCE !== 'undefined'
      ? ORCA_BUILD_PROVENANCE
      : ((globalThis as { ORCA_BUILD_PROVENANCE?: string | null }).ORCA_BUILD_PROVENANCE ?? null)
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as EmbeddedBuildProvenance
    return typeof parsed?.schemaVersion === 'number' ? parsed : null
  } catch {
    return null
  }
}

export type RuntimeBuildIdentity = {
  version: string
  buildHash: string
  /** How `commitSha` was established. Only `embedded` proves the artifact. */
  provenanceSource: BuildProvenanceSource
  /** True when the build was made from a dirty tree, so it matches no commit. */
  dirtyBuild: boolean | null
  /** The Git commit this runtime was BUILT FROM.
   *  Null when it cannot be established, which makes PASS evidence fail closed:
   *  a caller-supplied SHA is an assertion, never the runtime's own identity. */
  commitSha: string | null
  /** The value written to and compared against `RouteEvidence.runtimeVersion`.
   *  Includes the commit, so two builds of one version at different commits are
   *  different runtimes. */
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

/** The commit the running code was built from, owned by the runtime.
 *
 *  Uses the repository's own sync git runner rather than re-implementing ref
 *  resolution: worktrees, packed refs and detached HEADs are git's problem, and
 *  a second parser here is one more thing that can disagree with git. A build
 *  with no repository above it — a packaged app — yields null, and SHA-bound
 *  certification then refuses rather than trusting whatever SHA a caller typed.
 */
export function resolveRuntimeCommitSha(entryPath = process.argv[1]): string | null {
  if (!entryPath) {
    return null
  }
  try {
    const cwd = dirname(resolve(entryPath))
    const sha = gitExecFileSync(['rev-parse', 'HEAD'], { cwd }).trim()
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      return null
    }
    // Why status too: HEAD alone says which commit the tree is ON, not which
    // commit the running code IS. A dirty checkout — or a stale bundle in a repo
    // whose HEAD has moved — would otherwise stamp evidence with a commit the
    // executing code never came from. The embedded path already refuses a dirty
    // build; this one has to as well or it is the softer way in.
    return gitExecFileSync(['status', '--porcelain'], { cwd }).trim().length === 0 ? sha : null
  } catch {
    return null
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

  // Why embedded first: it describes the artifact. Reading the checkout is a
  // dev-only fallback and is labelled as such, so evidence can never quietly
  // rest on "whatever commit the tree is on right now".
  const embedded = readEmbeddedBuildProvenance()
  if (embedded) {
    return {
      version: embedded.appVersion || version,
      buildHash,
      commitSha: embedded.dirty === true ? null : embedded.sourceSha,
      provenanceSource: 'embedded',
      dirtyBuild: embedded.dirty,
      id: `${embedded.appVersion || version}+${buildHash}+${
        embedded.dirty === true ? 'dirty' : (embedded.sourceSha ?? 'nocommit')
      }`
    }
  }
  // Null now means "no repository above it, or a tree that does not match any
  // commit" — both of which must refuse a SHA-bound claim rather than guess.
  const commitSha = resolveRuntimeCommitSha(entryPath)
  return {
    version,
    buildHash,
    commitSha,
    provenanceSource: commitSha ? 'checkout' : 'unknown',
    dirtyBuild: null,
    id: `${version}+${buildHash}+${commitSha ?? 'nocommit'}`
  }
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
