import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
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
  artifactAggregate?: string | null
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
  /** True only when every file named by the build-generated artifact manifest
   * matched its byte hash and the manifest's aggregate. */
  artifactManifestVerified: boolean
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

export function isCertifiableRuntimeBuildIdentity(identity: RuntimeBuildIdentity): boolean {
  return (
    identity.artifactManifestVerified &&
    identity.provenanceSource === 'embedded' &&
    identity.dirtyBuild === false &&
    typeof identity.commitSha === 'string' &&
    /^[0-9a-f]{40}$/.test(identity.commitSha)
  )
}

type BuildArtifactManifest = {
  schemaVersion: number
  aggregateHash: string
  files: { path: string; size: number; sha256: string }[]
}

const ARTIFACT_MANIFEST = 'orca-artifact-manifest.json'
const ARTIFACT_AGGREGATE_PLACEHOLDER = 'ORCA_ARTIFACT_AGGREGATE_PLACEHOLDER'.padEnd(64, '_')

function replaceAllBytes(bytes: Buffer, needleText: string, replacementText: string): Buffer {
  const needle = Buffer.from(needleText)
  const replacement = Buffer.from(replacementText)
  if (needle.byteLength !== replacement.byteLength) {
    return bytes
  }
  const output = Buffer.from(bytes)
  let cursor = 0
  while ((cursor = output.indexOf(needle, cursor)) !== -1) {
    replacement.copy(output, cursor)
    cursor += replacement.byteLength
  }
  return output
}

function artifactFiles(root: string, current = root): string[] {
  const files: string[] = []
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = resolve(current, entry.name)
    const name = relative(root, absolute).split('\\').join('/')
    if (
      name === ARTIFACT_MANIFEST ||
      name.startsWith('electron-dev/') ||
      name.includes('/.vite/') ||
      name.endsWith('.test.js')
    ) {
      continue
    }
    if (entry.isDirectory()) {
      files.push(...artifactFiles(root, absolute))
    } else if (entry.isFile()) {
      files.push(absolute)
    }
  }
  return files
}

function findArtifactManifest(entryPath: string): string | null {
  let current = statSync(entryPath, { throwIfNoEntry: false })?.isDirectory()
    ? resolve(entryPath)
    : dirname(resolve(entryPath))
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = resolve(current, ARTIFACT_MANIFEST)
    if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) {
      return candidate
    }
    const parent = dirname(current)
    if (parent === current) {
      break
    }
    current = parent
  }
  return null
}

export function computeRuntimeArtifactIdentity(
  entryPath = process.argv[1],
  expectedAggregate = readEmbeddedBuildProvenance()?.artifactAggregate ?? null
): {
  buildHash: string
  verified: boolean
} {
  if (!entryPath) {
    return { buildHash: 'unknown', verified: false }
  }
  try {
    const manifestPath = findArtifactManifest(entryPath)
    if (manifestPath) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BuildArtifactManifest
      const root = dirname(manifestPath)
      if (
        manifest.schemaVersion !== 2 ||
        !/^[0-9a-f]{64}$/.test(manifest.aggregateHash) ||
        expectedAggregate !== manifest.aggregateHash ||
        !Array.isArray(manifest.files) ||
        manifest.files.length === 0
      ) {
        return { buildHash: 'invalid-manifest', verified: false }
      }
      const normalized = [...manifest.files].sort((left, right) =>
        left.path.localeCompare(right.path)
      )
      const actualPaths = artifactFiles(root)
        .map((absolute) => relative(root, absolute).split('\\').join('/'))
        .sort()
      if (
        actualPaths.length !== normalized.length ||
        actualPaths.some((path, index) => path !== normalized[index]?.path)
      ) {
        return { buildHash: 'artifact-set-mismatch', verified: false }
      }
      const seen = new Set<string>()
      const canonicalRecords: { path: string; size: number; sha256: string }[] = []
      for (const file of normalized) {
        if (
          !file.path ||
          isAbsolute(file.path) ||
          file.path.split(/[\\/]/).includes('..') ||
          seen.has(file.path)
        ) {
          return { buildHash: 'invalid-manifest', verified: false }
        }
        seen.add(file.path)
        const absolute = resolve(root, file.path)
        if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
          return { buildHash: 'invalid-manifest', verified: false }
        }
        const bytes = readFileSync(absolute)
        const hash = createHash('sha256').update(bytes).digest('hex')
        if (bytes.byteLength !== file.size || hash !== file.sha256) {
          return { buildHash: hash.slice(0, 16), verified: false }
        }
        const canonicalBytes = replaceAllBytes(
          bytes,
          manifest.aggregateHash,
          ARTIFACT_AGGREGATE_PLACEHOLDER
        )
        canonicalRecords.push({
          path: file.path,
          size: canonicalBytes.byteLength,
          sha256: createHash('sha256').update(canonicalBytes).digest('hex')
        })
      }
      const aggregate = createHash('sha256')
        .update(
          canonicalRecords.map((file) => `${file.path}\0${file.size}\0${file.sha256}\n`).join('')
        )
        .digest('hex')
      return {
        buildHash: aggregate.slice(0, 16),
        verified: aggregate === manifest.aggregateHash
      }
    }
    // Source-mode fallback is deliberately labelled unverified. It keeps unit
    // tests and ordinary development usable, but cannot certify a packaged
    // route or exact-build receipt.
    return {
      buildHash: createHash('sha256').update(readFileSync(entryPath)).digest('hex').slice(0, 16),
      verified: false
    }
  } catch {
    return { buildHash: 'unknown', verified: false }
  }
}

export function computeRuntimeBuildHash(entryPath = process.argv[1]): string {
  return computeRuntimeArtifactIdentity(entryPath).buildHash
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
  const artifact = computeRuntimeArtifactIdentity(entryPath)
  const buildHash = artifact.buildHash

  // Why embedded first: it describes the artifact. Reading the checkout is a
  // dev-only fallback and is labelled as such, so evidence can never quietly
  // rest on "whatever commit the tree is on right now".
  const embedded = readEmbeddedBuildProvenance()
  if (embedded) {
    return {
      version: embedded.appVersion || version,
      buildHash,
      artifactManifestVerified: artifact.verified,
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
    artifactManifestVerified: artifact.verified,
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

/** Correction — one build identity per process, pinned at construction.
 *
 *  Resolving on demand re-read the checkout on every call, so the runtime's own
 *  identity moved whenever the tree moved: evidence recorded at the start of a
 *  certification run no longer matched the runtime that recorded it by the end.
 *  The identity of a RUNNING PROCESS cannot change, so it is computed once and
 *  frozen. A restarted process computes a new one and, because evidence is
 *  stamped with `id`, refuses the previous build's evidence exactly as before.
 */
let pinnedBuildIdentity: RuntimeBuildIdentity | null = null

/** Called at OrcaRuntime construction so the pin is taken before any RPC can
 *  read it. Idempotent: later callers get the identity the process started with,
 *  never a recomputation.
 *
 *  This is the construction seam ONLY. Consumers must read the pinned object
 *  from `OrcaRuntimeService.getBuildIdentity()`: a module-global reader is a
 *  second authority that can be reached from a context the runtime never
 *  constructed, which is how two answers to "what build is this" get back in. */
export function pinRuntimeBuildIdentity(entryPath = process.argv[1]): RuntimeBuildIdentity {
  pinnedBuildIdentity ??= Object.freeze(resolveRuntimeBuildIdentity(entryPath))
  return pinnedBuildIdentity
}

/** Test-only: simulate a process restart. Production code must never call this —
 *  a build whose identity can be reset mid-process is not an identity. */
export function resetPinnedRuntimeBuildIdentityForTest(): void {
  pinnedBuildIdentity = null
}
