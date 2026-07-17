import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

import { verifySshRelayRuntimeAggregateFiles } from './ssh-relay-runtime-aggregate-input.mjs'
import { inspectSshRelayRuntimeArchive } from './ssh-relay-runtime-archive.mjs'
import { assertSshRelayRuntimeClosureEntries } from './ssh-relay-runtime-closure.mjs'
import { computeSshRelayRuntimeContentId } from './ssh-relay-runtime-identity.mjs'
import { parseSshRelayRuntimeManifestTuple } from './ssh-relay-runtime-manifest-validation.mjs'
import { buildSshRelayRuntimeNativeSigningPlan } from './ssh-relay-runtime-native-signing-plan.mjs'
import { verifySshRelayRuntimePostSignMetadata } from './ssh-relay-runtime-post-sign-metadata.mjs'
import { verifyRuntimeTree } from './verify-ssh-relay-runtime.mjs'

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u
const ASSET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/u
const PRINTABLE_VERSION_PATTERN = /^[\x20-\x7e]+$/u
const TEAM_IDENTIFIER_PATTERN = /^[A-Z0-9]{10}$/u
const THUMBPRINT_PATTERN = /^[A-F0-9]{40}$/u
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024
const MAX_METADATA_BYTES = 32 * 1024 * 1024
const MAX_DESCRIPTOR_BYTES = 32 * 1024 * 1024
const PRODUCER_TIMEOUT_MS = 15 * 60_000
const NATIVE_ROLES = new Set(['node', 'node-pty-native', 'parcel-watcher-native', 'native-runtime'])

function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Runtime manifest tuple ${label} must be an object`)
  }
}

function assertExactFields(value, fields, label) {
  assertObject(value, label)
  const actual = Object.keys(value).sort(compareAscii)
  const expected = [...fields].sort(compareAscii)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Runtime manifest tuple ${label} has unexpected or missing fields`)
  }
}

function containsPath(parent, candidate) {
  const path = relative(parent, candidate)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`))
}

async function physicalDirectory(path, label) {
  const metadata = await lstat(path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Runtime manifest tuple ${label} must be a real directory`)
  }
  return realpath(path)
}

function expectedNames(identity) {
  const digest = identity.contentId.slice('sha256:'.length)
  const extension = identity.tupleId.startsWith('win32-') ? 'zip' : 'tar.br'
  const prefix = `orca-ssh-relay-runtime-${identity.tupleId}`
  return {
    archive: `orca-ssh-relay-runtime-v1-${identity.tupleId}-${digest}.${extension}`,
    sbom: `${prefix}.spdx.json`,
    provenance: `${prefix}.provenance.json`,
    descriptor: `${prefix}.manifest-tuple.json`
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

async function describeStableFile(root, name, maximumBytes, label, signal) {
  signal.throwIfAborted()
  const path = join(root, name)
  const before = await lstat(path, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`Runtime manifest tuple ${label} must be a regular file`)
  }
  if (before.size <= 0n || before.size > BigInt(maximumBytes)) {
    throw new Error(`Runtime manifest tuple ${label} exceeds its bounded size`)
  }
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(path, { signal })) {
    signal.throwIfAborted()
    size += chunk.length
    if (size > maximumBytes) {
      throw new Error(`Runtime manifest tuple ${label} exceeds its bounded size`)
    }
    hash.update(chunk)
  }
  const after = await lstat(path, { bigint: true })
  if (!sameFileState(before, after) || BigInt(size) !== before.size) {
    throw new Error(`Runtime manifest tuple ${label} changed while hashing`)
  }
  return { name, size, sha256: `sha256:${hash.digest('hex')}` }
}

async function assertInitialInputSet(root, names) {
  const entries = await readdir(root, { withFileTypes: true })
  const actual = entries.map((entry) => entry.name).sort(compareAscii)
  const expected = [names.archive, names.sbom, names.provenance].sort(compareAscii)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('Runtime manifest tuple requires an exclusive exact input set')
  }
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Runtime manifest tuple input must be a regular file: ${entry.name}`)
    }
  }
}

function assertFinalIdentity(identity) {
  assertObject(identity, 'final identity')
  assertSshRelayRuntimeClosureEntries(identity)
  const files = identity.entries.filter((entry) => entry.type === 'file')
  const expandedSize = files.reduce((total, entry) => total + entry.size, 0)
  if (
    Object.hasOwn(identity, 'archive') ||
    !DIGEST_PATTERN.test(identity.contentId ?? '') ||
    computeSshRelayRuntimeContentId(identity) !== identity.contentId ||
    identity.fileCount !== files.length ||
    identity.expandedSize !== expandedSize
  ) {
    throw new Error('Runtime manifest tuple final content identity is inconsistent')
  }
}

function assertVerificationFileShape(file, platform) {
  assertObject(file, 'native verification file')
  if (
    typeof file.path !== 'string' ||
    typeof file.role !== 'string' ||
    !DIGEST_PATTERN.test(file.sha256 ?? '')
  ) {
    throw new Error('Runtime manifest tuple native verification file is malformed')
  }
  if (platform === 'darwin') {
    const signerKind = file.role === 'node' ? 'official-node' : 'orca-built'
    if (
      file.signerKind !== signerKind ||
      typeof file.authority !== 'string' ||
      file.authority.length === 0 ||
      !TEAM_IDENTIFIER_PATTERN.test(file.teamIdentifier ?? '')
    ) {
      throw new Error('Runtime manifest tuple macOS native verification report is incomplete')
    }
  } else if (platform === 'win32') {
    if (
      (file.role === 'node'
        ? file.signerKind !== 'official-node'
        : !['orca-built', 'preserved-upstream'].includes(file.signerKind)) ||
      typeof file.signerSubject !== 'string' ||
      file.signerSubject.length === 0 ||
      !THUMBPRINT_PATTERN.test(file.signerThumbprint ?? '')
    ) {
      throw new Error('Runtime manifest tuple Windows native verification report is incomplete')
    }
  }
}

export function createSshRelayRuntimeManifestNativeVerification({
  identity,
  report,
  tool,
  verifiedAt
}) {
  assertObject(report, 'native verification report')
  const plan = buildSshRelayRuntimeNativeSigningPlan(identity)
  if (report.tupleId !== identity.tupleId || report.finalContentId !== identity.contentId) {
    throw new Error('Runtime manifest tuple native verification content identity is stale')
  }
  if (
    plan.platform === 'linux'
      ? report.sourceContentId !== undefined && report.sourceContentId !== identity.contentId
      : !DIGEST_PATTERN.test(report.sourceContentId ?? '') ||
        report.sourceContentId === identity.contentId
  ) {
    throw new Error('Runtime manifest tuple native verification source identity is invalid')
  }
  if (!Array.isArray(report.verifiedFiles)) {
    throw new Error('Runtime manifest tuple native verification files must be an array')
  }
  const actual = new Map()
  for (const file of report.verifiedFiles) {
    assertVerificationFileShape(file, plan.platform)
    if (actual.has(file.path)) {
      throw new Error(`Runtime manifest tuple has duplicate native verification: ${file.path}`)
    }
    actual.set(file.path, file)
  }
  const expected = plan.verificationFiles
  if (actual.size !== expected.length) {
    throw new Error('Runtime manifest tuple native verification report is not complete')
  }
  for (const file of expected) {
    const verified = actual.get(file.path)
    if (
      !verified ||
      verified.role !== file.role ||
      verified.sha256 !== file.sourceSha256 ||
      !NATIVE_ROLES.has(verified.role)
    ) {
      throw new Error(`Runtime manifest tuple native verification hash mismatch: ${file.path}`)
    }
  }
  assertExactFields(tool, ['name', 'version'], 'native verification tool')
  if (
    typeof tool.name !== 'string' ||
    !ASSET_NAME_PATTERN.test(tool.name) ||
    typeof tool.version !== 'string' ||
    tool.version.length > 64 ||
    !PRINTABLE_VERSION_PATTERN.test(tool.version)
  ) {
    throw new Error('Runtime manifest tuple native verification tool is invalid')
  }
  if (
    typeof verifiedAt !== 'string' ||
    new Date(verifiedAt).toISOString() !== verifiedAt ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(verifiedAt)
  ) {
    throw new Error('Runtime manifest tuple verified timestamp is not canonical')
  }
  return {
    policy: plan.policy,
    tool: { name: tool.name, version: tool.version },
    verifiedAt,
    files: expected.map((file) => ({ path: file.path, sha256: file.sourceSha256 }))
  }
}

function tupleProjection(identity, archive, sbom, provenance, verification) {
  return {
    tupleId: identity.tupleId,
    os: identity.os,
    architecture: identity.architecture,
    compatibility: identity.compatibility,
    nodeVersion: identity.nodeVersion,
    dependencies: identity.dependencies,
    entries: identity.entries,
    contentId: identity.contentId,
    archive: {
      ...archive,
      expandedSize: identity.expandedSize,
      fileCount: identity.fileCount
    },
    metadataAssets: { sbom, provenance },
    nativeVerification: verification
  }
}

export async function writeSshRelayRuntimeManifestTupleDescriptor({
  runtimeRoot,
  inputDirectory,
  finalIdentity,
  verificationReport,
  nativeVerificationTool,
  verifiedAt,
  signal
}) {
  const effectiveSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(PRODUCER_TIMEOUT_MS)])
    : AbortSignal.timeout(PRODUCER_TIMEOUT_MS)
  effectiveSignal.throwIfAborted()
  assertFinalIdentity(finalIdentity)
  const verification = createSshRelayRuntimeManifestNativeVerification({
    identity: finalIdentity,
    report: verificationReport,
    tool: nativeVerificationTool,
    verifiedAt
  })
  const [physicalRuntime, physicalInput] = await Promise.all([
    physicalDirectory(resolve(runtimeRoot), 'runtime root'),
    physicalDirectory(resolve(inputDirectory), 'input root')
  ])
  if (
    containsPath(physicalRuntime, physicalInput) ||
    containsPath(physicalInput, physicalRuntime)
  ) {
    throw new Error('Runtime manifest tuple runtime and input roots must be physically disjoint')
  }
  const names = expectedNames(finalIdentity)
  await assertInitialInputSet(physicalInput, names)
  // Why: a native report cannot authorize a descriptor for bytes that changed after its probes.
  await verifyRuntimeTree(physicalRuntime, finalIdentity)
  const [archive, sbom, provenance] = await Promise.all([
    describeStableFile(physicalInput, names.archive, MAX_ARCHIVE_BYTES, 'archive', effectiveSignal),
    describeStableFile(
      physicalInput,
      names.sbom,
      MAX_METADATA_BYTES,
      'SBOM metadata',
      effectiveSignal
    ),
    describeStableFile(
      physicalInput,
      names.provenance,
      MAX_METADATA_BYTES,
      'provenance metadata',
      effectiveSignal
    )
  ])
  await inspectSshRelayRuntimeArchive(join(physicalInput, names.archive), finalIdentity, {
    signal: effectiveSignal
  })
  await verifySshRelayRuntimePostSignMetadata({
    finalIdentity,
    archive: { ...archive, path: join(physicalInput, names.archive) },
    sbomPath: join(physicalInput, names.sbom),
    provenancePath: join(physicalInput, names.provenance),
    signal: effectiveSignal
  })
  await verifyRuntimeTree(physicalRuntime, finalIdentity)
  const tuple = parseSshRelayRuntimeManifestTuple(
    tupleProjection(finalIdentity, archive, sbom, provenance, verification)
  )
  const descriptorBytes = Buffer.from(
    `${JSON.stringify({ schemaVersion: 1, tuple }, null, 2)}\n`,
    'utf8'
  )
  if (descriptorBytes.length === 0 || descriptorBytes.length > MAX_DESCRIPTOR_BYTES) {
    throw new Error('Runtime manifest tuple descriptor exceeds its bounded size')
  }
  const descriptor = {
    name: names.descriptor,
    size: descriptorBytes.length,
    sha256: `sha256:${createHash('sha256').update(descriptorBytes).digest('hex')}`
  }
  const descriptorPath = join(physicalInput, names.descriptor)
  let descriptorWritten = false
  try {
    await writeFile(descriptorPath, descriptorBytes, {
      flag: 'wx',
      mode: 0o600,
      signal: effectiveSignal
    })
    descriptorWritten = true
    await verifySshRelayRuntimeAggregateFiles({
      inputDirectory: physicalInput,
      files: [descriptor, archive, sbom, provenance],
      signal: effectiveSignal
    })
    return {
      tupleId: finalIdentity.tupleId,
      tuple,
      input: { tupleId: finalIdentity.tupleId, descriptor, archive, sbom, provenance }
    }
  } catch (error) {
    if (descriptorWritten) {
      await rm(descriptorPath, { force: true })
    }
    throw error
  }
}

export const SSH_RELAY_RUNTIME_MANIFEST_TUPLE_LIMITS = Object.freeze({
  maximumArchiveBytes: MAX_ARCHIVE_BYTES,
  maximumMetadataBytes: MAX_METADATA_BYTES,
  maximumDescriptorBytes: MAX_DESCRIPTOR_BYTES,
  timeoutMs: PRODUCER_TIMEOUT_MS
})
