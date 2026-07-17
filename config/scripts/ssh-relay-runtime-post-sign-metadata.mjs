import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { inspectSshRelayRuntimeArchive } from './ssh-relay-runtime-archive.mjs'
import { assertSshRelayRuntimeClosureEntries } from './ssh-relay-runtime-closure.mjs'
import { computeSshRelayRuntimeContentId } from './ssh-relay-runtime-identity.mjs'
import { createSshRelayRuntimeProvenance } from './ssh-relay-runtime-provenance.mjs'
import { createSshRelayRuntimeSbom } from './ssh-relay-runtime-sbom.mjs'
import { assertSshRelayRuntimeToolchain } from './ssh-relay-runtime-toolchain.mjs'
import { verifyRuntimeTree } from './verify-ssh-relay-runtime.mjs'

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u
const MAX_METADATA_BYTES = 32 * 1024 * 1024
const METADATA_TIMEOUT_MS = 15 * 60_000
const NATIVE_ROLES = new Set(['node', 'node-pty-native', 'parcel-watcher-native', 'native-runtime'])

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Runtime post-sign metadata ${label} must be an object`)
  }
}

function containsPath(parent, candidate) {
  const path = relative(parent, candidate)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`))
}

async function physicalDirectory(path, label) {
  const metadata = await lstat(path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Runtime post-sign metadata ${label} must be a real directory`)
  }
  return realpath(path)
}

function expectedNames(identity) {
  const prefix = `orca-ssh-relay-runtime-${identity.tupleId}`
  const extension = identity.os === 'win32' ? 'zip' : 'tar.br'
  return {
    archive: `orca-ssh-relay-runtime-v1-${identity.tupleId}-${identity.contentId.slice('sha256:'.length)}.${extension}`,
    sbom: `${prefix}.spdx.json`,
    provenance: `${prefix}.provenance.json`
  }
}

function assertFinalIdentity(identity) {
  assertObject(identity, 'final identity')
  assertSshRelayRuntimeClosureEntries(identity)
  const files = identity.entries.filter((entry) => entry.type === 'file')
  if (
    Object.hasOwn(identity, 'archive') ||
    !DIGEST_PATTERN.test(identity.contentId ?? '') ||
    computeSshRelayRuntimeContentId(identity) !== identity.contentId ||
    identity.fileCount !== files.length ||
    identity.expandedSize !== files.reduce((total, entry) => total + entry.size, 0)
  ) {
    throw new Error('Runtime post-sign metadata final content identity is inconsistent')
  }
}

function sameFileState(before, after) {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  )
}

async function readStableFile(path, maximumBytes, label, signal) {
  signal.throwIfAborted()
  const before = await lstat(path, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`Runtime post-sign metadata ${label} must be a regular file`)
  }
  if (before.size <= 0n || before.size > BigInt(maximumBytes)) {
    throw new Error(`Runtime post-sign metadata ${label} exceeds its bounded size`)
  }
  const bytes = await readFile(path, { signal })
  const after = await lstat(path, { bigint: true })
  if (!sameFileState(before, after) || BigInt(bytes.length) !== before.size) {
    throw new Error(`Runtime post-sign metadata ${label} changed while reading`)
  }
  return bytes
}

async function readStableJson(path, label, signal) {
  const bytes = await readStableFile(path, MAX_METADATA_BYTES, label, signal)
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new Error(`Runtime post-sign metadata ${label} is not valid JSON: ${error.message}`)
  }
}

function assertArchiveReference(archive, identity, names) {
  assertObject(archive, 'archive reference')
  if (
    archive.name !== names.archive ||
    basename(archive.path ?? '') !== names.archive ||
    !Number.isSafeInteger(archive.size) ||
    archive.size <= 0 ||
    !DIGEST_PATTERN.test(archive.sha256 ?? '')
  ) {
    throw new Error('Runtime post-sign metadata archive reference is inconsistent')
  }
}

async function verifyArchiveReference(outputRoot, archive, identity, names, signal) {
  assertArchiveReference(archive, identity, names)
  const archivePath = join(outputRoot, names.archive)
  if ((await realpath(resolve(archive.path))) !== (await realpath(archivePath))) {
    throw new Error('Runtime post-sign metadata archive must be inside the exclusive output root')
  }
  const bytes = await readStableFile(archivePath, 100 * 1024 * 1024, 'archive', signal)
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  if (bytes.length !== archive.size || digest !== archive.sha256) {
    throw new Error('Runtime post-sign metadata archive size or digest mismatch')
  }
  await inspectSshRelayRuntimeArchive(archivePath, identity, { signal })
  return { name: archive.name, size: archive.size, sha256: archive.sha256 }
}

function expectedNativeFiles(identity) {
  return identity.entries
    .filter((entry) => entry.type === 'file' && NATIVE_ROLES.has(entry.role))
    .map((entry) => ({ path: entry.path, sha256: entry.sha256 }))
}

function validResolvedDependencies(dependencies, identity) {
  const expectedCount = identity.os === 'win32' ? 5 : 3
  return (
    Array.isArray(dependencies) &&
    dependencies.length === expectedCount &&
    dependencies.every((entry) => {
      const digests = Object.entries(entry?.digest ?? {})
      return (
        typeof entry?.uri === 'string' &&
        entry.uri.length > 0 &&
        digests.length === 1 &&
        ((digests[0][0] === 'sha256' && /^[0-9a-f]{64}$/u.test(digests[0][1])) ||
          (digests[0][0] === 'gitCommit' && /^[0-9a-f]{40}$/u.test(digests[0][1])))
      )
    })
  )
}

function validRunner(runner) {
  return (
    runner !== null &&
    typeof runner === 'object' &&
    !Array.isArray(runner) &&
    ['os', 'architecture', 'environment', 'requestedLabel'].every(
      (field) => typeof runner[field] === 'string' && runner[field].length > 0
    ) &&
    typeof runner.image?.os === 'string' &&
    runner.image.os.length > 0 &&
    typeof runner.image?.version === 'string' &&
    runner.image.version.length > 0
  )
}

function assertSbomBinding(sbom, identity, archive) {
  assertObject(sbom, 'SBOM')
  const created = sbom.creationInfo?.created
  const createdMilliseconds = typeof created === 'string' ? Date.parse(created) : Number.NaN
  if (!Number.isSafeInteger(createdMilliseconds) || createdMilliseconds % 1000 !== 0) {
    throw new Error('Runtime post-sign metadata SBOM creation timestamp is invalid')
  }
  const expected = createSshRelayRuntimeSbom({
    identity,
    archive,
    sourceDateEpoch: createdMilliseconds / 1000
  })
  if (!isDeepStrictEqual(sbom, expected)) {
    const relay = sbom.packages?.filter((entry) => entry.name === 'orca-ssh-relay') ?? []
    if (relay.length !== 1 || relay[0].versionInfo !== identity.contentId) {
      throw new Error('Runtime post-sign metadata SBOM content identity is stale')
    }
    throw new Error('Runtime post-sign metadata SBOM file or archive binding is stale')
  }
}

function assertProvenanceBinding(provenance, identity, archive) {
  assertObject(provenance, 'provenance')
  const expectedSubject = [
    { name: archive.name, digest: { sha256: archive.sha256.slice('sha256:'.length) } }
  ]
  if (!isDeepStrictEqual(provenance.subject, expectedSubject)) {
    throw new Error('Runtime post-sign metadata provenance archive binding is stale')
  }
  const definition = provenance.predicate?.buildDefinition
  const parameters = definition?.externalParameters
  const runDetails = provenance.predicate?.runDetails
  if (
    provenance._type !== 'https://in-toto.io/Statement/v1' ||
    provenance.predicateType !== 'https://slsa.dev/provenance/v1' ||
    definition?.buildType !== 'https://github.com/stablyai/orca/ssh-relay-runtime-build/v1' ||
    parameters?.tuple !== identity.tupleId ||
    parameters?.nodeVersion !== identity.nodeVersion ||
    parameters?.contentId !== identity.contentId ||
    !Number.isSafeInteger(parameters?.sourceDateEpoch) ||
    !isDeepStrictEqual(Object.keys(parameters).sort(), [
      'contentId',
      'nodeVersion',
      'sourceDateEpoch',
      'tuple'
    ]) ||
    !validResolvedDependencies(definition.resolvedDependencies, identity) ||
    typeof runDetails?.builder?.id !== 'string' ||
    runDetails.builder.id.length === 0 ||
    typeof runDetails?.metadata?.invocationId !== 'string' ||
    runDetails.metadata.invocationId.length === 0 ||
    !validRunner(runDetails.metadata.runner)
  ) {
    throw new Error('Runtime post-sign metadata provenance content identity is stale')
  }
  assertSshRelayRuntimeToolchain(definition.internalParameters?.toolchain, identity.tupleId)
  const expectedByproducts = [{ name: 'native-files', content: expectedNativeFiles(identity) }]
  if (!isDeepStrictEqual(runDetails.byproducts, expectedByproducts)) {
    throw new Error('Runtime post-sign metadata provenance native-file binding is stale')
  }
}

export async function verifySshRelayRuntimePostSignMetadata({
  finalIdentity,
  archive,
  sbomPath,
  provenancePath,
  signal
}) {
  const effectiveSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(METADATA_TIMEOUT_MS)])
    : AbortSignal.timeout(METADATA_TIMEOUT_MS)
  effectiveSignal.throwIfAborted()
  assertFinalIdentity(finalIdentity)
  const names = expectedNames(finalIdentity)
  assertArchiveReference(archive, finalIdentity, names)
  const [sbom, provenance] = await Promise.all([
    readStableJson(resolve(sbomPath), 'SBOM', effectiveSignal),
    readStableJson(resolve(provenancePath), 'provenance', effectiveSignal)
  ])
  assertSbomBinding(sbom, finalIdentity, archive)
  assertProvenanceBinding(provenance, finalIdentity, archive)
  return { sbom, provenance }
}

function jsonAsset(name, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
  if (bytes.length === 0 || bytes.length > MAX_METADATA_BYTES) {
    throw new Error(`Runtime post-sign metadata ${name} exceeds its bounded size`)
  }
  return {
    bytes,
    reference: {
      name,
      size: bytes.length,
      sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    }
  }
}

async function assertExclusiveArchive(root, archiveName) {
  const entries = await readdir(root, { withFileTypes: true })
  if (entries.length !== 1 || entries[0].name !== archiveName || !entries[0].isFile()) {
    throw new Error('Runtime post-sign metadata requires an exclusive exact archive input')
  }
}

export async function writeSshRelayRuntimePostSignMetadata({
  runtimeRoot,
  outputDirectory,
  finalIdentity,
  archive,
  nodeRelease,
  sourceDateEpoch,
  gitCommit,
  builder,
  runner,
  toolchain,
  signal
}) {
  const effectiveSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(METADATA_TIMEOUT_MS)])
    : AbortSignal.timeout(METADATA_TIMEOUT_MS)
  effectiveSignal.throwIfAborted()
  assertFinalIdentity(finalIdentity)
  const names = expectedNames(finalIdentity)
  const [physicalRuntime, physicalOutput] = await Promise.all([
    physicalDirectory(resolve(runtimeRoot), 'runtime root'),
    physicalDirectory(resolve(outputDirectory), 'output root')
  ])
  if (
    containsPath(physicalRuntime, physicalOutput) ||
    containsPath(physicalOutput, physicalRuntime)
  ) {
    throw new Error(
      'Runtime post-sign metadata runtime and output roots must be physically disjoint'
    )
  }
  await assertExclusiveArchive(physicalOutput, names.archive)
  await verifyRuntimeTree(physicalRuntime, finalIdentity)
  const archiveReference = await verifyArchiveReference(
    physicalOutput,
    archive,
    finalIdentity,
    names,
    effectiveSignal
  )
  const sbom = createSshRelayRuntimeSbom({ identity: finalIdentity, archive, sourceDateEpoch })
  const provenance = createSshRelayRuntimeProvenance({
    identity: finalIdentity,
    archive,
    nodeRelease,
    sourceDateEpoch,
    gitCommit,
    builder,
    runner,
    toolchain
  })
  const sbomAsset = jsonAsset(names.sbom, sbom)
  const provenanceAsset = jsonAsset(names.provenance, provenance)
  const written = []
  try {
    for (const asset of [sbomAsset, provenanceAsset]) {
      const path = join(physicalOutput, asset.reference.name)
      written.push(path)
      await writeFile(path, asset.bytes, { flag: 'wx', mode: 0o600, signal: effectiveSignal })
    }
    const verified = await verifySshRelayRuntimePostSignMetadata({
      finalIdentity,
      archive,
      sbomPath: join(physicalOutput, names.sbom),
      provenancePath: join(physicalOutput, names.provenance),
      signal: effectiveSignal
    })
    if (!isDeepStrictEqual(verified, { sbom, provenance })) {
      throw new Error('Runtime post-sign metadata changed after exclusive publication')
    }
    // Why: metadata is usable only if the final tree and archive remain unchanged through emission.
    await verifyRuntimeTree(physicalRuntime, finalIdentity)
    await verifyArchiveReference(physicalOutput, archive, finalIdentity, names, effectiveSignal)
    return {
      tupleId: finalIdentity.tupleId,
      contentId: finalIdentity.contentId,
      archive: archiveReference,
      sbom: sbomAsset.reference,
      provenance: provenanceAsset.reference
    }
  } catch (error) {
    await Promise.all(written.map((path) => rm(path, { force: true })))
    throw error
  }
}

export const SSH_RELAY_RUNTIME_POST_SIGN_METADATA_LIMITS = Object.freeze({
  maximumMetadataBytes: MAX_METADATA_BYTES,
  timeoutMs: METADATA_TIMEOUT_MS
})
