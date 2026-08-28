import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

/**
 * Immutable build provenance, computed ONCE at build time and folded into the
 * bundle as a literal.
 *
 * Why not resolve this at runtime: a runtime that reads the checkout's current
 * HEAD reports whatever the tree happens to be at the moment it is asked, so a
 * build made at commit A starts claiming commit B the instant someone checks
 * out B. Certification evidence bound to that is meaningless. Baking the value
 * in at build time is what makes "the source this runtime was built from" a
 * fact about the artifact rather than about the working tree.
 *
 * `sourceSha` is null when there is no repository above the build (a packaged
 * artifact built elsewhere, or a folder workspace). Null is honest; a guessed
 * commit is not.
 */

const PROVENANCE_SCHEMA_VERSION = 2
export const ARTIFACT_AGGREGATE_PLACEHOLDER = 'ORCA_ARTIFACT_AGGREGATE_PLACEHOLDER'.padEnd(64, '_')

function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return null
  }
}

export function readBuildProvenance(repoRoot = process.cwd()) {
  const root = resolve(repoRoot)
  const sourceSha = git(['rev-parse', 'HEAD'], root)
  // Why porcelain: a build from a dirty tree does not correspond to any commit,
  // and evidence must be able to say so rather than quietly citing the last one.
  const status = sourceSha === null ? null : git(['status', '--porcelain'], root)
  let version = '0.0.0'
  try {
    version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version ?? '0.0.0'
  } catch {
    // Keep the placeholder; the caller still gets a usable record.
  }
  return {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    sourceSha: sourceSha && /^[0-9a-f]{40}$/.test(sourceSha) ? sourceSha : null,
    dirty: status === null ? null : status.length > 0,
    appVersion: version,
    builtAt: new Date().toISOString(),
    // Replaced only after every emitted target exists. Keeping the placeholder
    // the same byte length lets the post-build sealer bind the full artifact
    // without changing source-map offsets or creating a hash cycle.
    artifactAggregate: ARTIFACT_AGGREGATE_PLACEHOLDER
  }
}

function buildGeneratedUntracked(path) {
  return (
    /^electron\.vite\.config\.[^/]+\.mjs$/.test(path) ||
    path.startsWith('out/') ||
    path.startsWith('dist/')
  )
}

/** A child build may inherit the one provenance record measured by the
 * parallel parent, but environment bytes are not authority by themselves.
 * Re-verify the immutable fields against Git and reject any tracked/staged or
 * non-build-generated untracked input. This keeps all three targets on one
 * timestamp while preventing a caller from asserting a clean SHA over dirty or
 * different source. */
export function verifyInheritedBuildProvenance(raw, repoRoot = process.cwd()) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Inherited Orca build provenance is not valid JSON.')
  }
  if (
    !parsed ||
    parsed.schemaVersion !== PROVENANCE_SCHEMA_VERSION ||
    parsed.dirty !== false ||
    typeof parsed.sourceSha !== 'string' ||
    !/^[0-9a-f]{40}$/.test(parsed.sourceSha)
  ) {
    throw new Error('Inherited Orca build provenance is not a clean exact-SHA record.')
  }
  const root = resolve(repoRoot)
  const actualSha = git(['rev-parse', 'HEAD'], root)
  const trackedDirty =
    git(['diff', '--name-only'], root) || git(['diff', '--cached', '--name-only'], root)
  const untracked = (git(['ls-files', '--others', '--exclude-standard'], root) ?? '')
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => !buildGeneratedUntracked(entry))
  let actualVersion = null
  try {
    actualVersion = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version
  } catch {
    actualVersion = null
  }
  if (
    actualSha !== parsed.sourceSha ||
    trackedDirty ||
    untracked.length > 0 ||
    actualVersion !== parsed.appVersion
  ) {
    throw new Error(
      'Inherited Orca build provenance does not match the exact clean source tree being built.'
    )
  }
  return parsed
}

/** Prefers provenance the build wrapper already computed, because by the time a
 *  bundler config is evaluated the bundler has usually written scratch files
 *  into the tree it would be measuring. */
export function buildProvenanceLiteral(repoRoot = process.cwd()) {
  const handed = process.env.ORCA_BUILD_PROVENANCE_JSON
  if (handed) {
    verifyInheritedBuildProvenance(handed, repoRoot)
    return JSON.stringify(handed)
  }
  return JSON.stringify(JSON.stringify(readBuildProvenance(repoRoot)))
}

export const BUILD_ARTIFACT_MANIFEST = 'orca-artifact-manifest.json'

function artifactFiles(root, current = root) {
  const files = []
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = resolve(current, entry.name)
    const name = relative(root, absolute).split('\\').join('/')
    if (
      name === BUILD_ARTIFACT_MANIFEST ||
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

function replaceAllBytes(bytes, needleText, replacementText) {
  const needle = Buffer.from(needleText)
  const replacement = Buffer.from(replacementText)
  if (needle.byteLength !== replacement.byteLength) {
    throw new Error('Artifact provenance replacement must preserve byte length.')
  }
  const output = Buffer.from(bytes)
  let cursor = 0
  while ((cursor = output.indexOf(needle, cursor)) !== -1) {
    replacement.copy(output, cursor)
    cursor += replacement.byteLength
  }
  return output
}

/** Writes a deterministic inventory of every executable asset under `out/`.
 * The manifest itself is excluded, so byte-identical output yields the same
 * aggregate regardless of build timestamp or filesystem enumeration order. */
export function writeBuildArtifactManifest(
  repoRoot = process.cwd(),
  inheritedProvenance = process.env.ORCA_BUILD_PROVENANCE_JSON
) {
  if (!inheritedProvenance) {
    throw new Error('Cannot seal artifact provenance without the build-time source record.')
  }
  // Re-check at the END of compilation. A clean tree at start is not proof that
  // the bytes compiled during a long build still came from that tree.
  verifyInheritedBuildProvenance(inheritedProvenance, repoRoot)
  const outRoot = resolve(repoRoot, 'out')
  if (!statSync(outRoot, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Cannot write artifact provenance: ${outRoot} does not exist.`)
  }
  const emitted = artifactFiles(outRoot)
  const placeholder = Buffer.from(ARTIFACT_AGGREGATE_PLACEHOLDER)
  let embeddedOccurrences = 0
  const canonicalFiles = emitted
    .map((absolute) => {
      const bytes = readFileSync(absolute)
      let cursor = 0
      while ((cursor = bytes.indexOf(placeholder, cursor)) !== -1) {
        embeddedOccurrences += 1
        cursor += placeholder.byteLength
      }
      return {
        path: relative(outRoot, absolute).split('\\').join('/'),
        size: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex')
      }
    })
    .sort((left, right) => left.path.localeCompare(right.path))
  if (embeddedOccurrences === 0) {
    throw new Error('Built artifact does not contain its provenance authority placeholder.')
  }
  const aggregateHash = createHash('sha256')
    .update(canonicalFiles.map((file) => `${file.path}\0${file.size}\0${file.sha256}\n`).join(''))
    .digest('hex')

  // Seal the authority into every bundle/source-map location that carries the
  // provenance literal. Replacing exactly 64 bytes preserves emitted layout.
  for (const absolute of emitted) {
    const bytes = readFileSync(absolute)
    if (!bytes.includes(placeholder)) {
      continue
    }
    writeFileSync(absolute, replaceAllBytes(bytes, ARTIFACT_AGGREGATE_PLACEHOLDER, aggregateHash))
  }
  const files = artifactFiles(outRoot)
    .map((absolute) => {
      const bytes = readFileSync(absolute)
      return {
        path: relative(outRoot, absolute).split('\\').join('/'),
        size: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex')
      }
    })
    .sort((left, right) => left.path.localeCompare(right.path))
  const manifest = { schemaVersion: 2, aggregateHash, files }
  writeFileSync(resolve(outRoot, BUILD_ARTIFACT_MANIFEST), `${JSON.stringify(manifest)}\n`, {
    mode: 0o644
  })
  return manifest
}
