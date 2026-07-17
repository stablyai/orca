import { constants } from 'node:fs'
import { copyFile, lstat, readFile, readdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

const MAX_RECEIPT_BYTES = 32 * 1024 * 1024
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/u
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const INPUT_FIELDS = ['archive', 'descriptor', 'provenance', 'sbom', 'tupleId']
const FILE_FIELDS = ['name', 'sha256', 'size']

export const SSH_RELAY_RUNTIME_MANIFEST_ARTIFACTS = Object.freeze([
  {
    tupleId: 'linux-x64-glibc',
    artifactName: 'ssh-relay-runtime-linux-x64-glibc',
    layout: 'flat'
  },
  {
    tupleId: 'linux-arm64-glibc',
    artifactName: 'ssh-relay-runtime-linux-arm64-glibc',
    layout: 'flat'
  },
  {
    tupleId: 'darwin-x64',
    artifactName: 'ssh-relay-runtime-signed-darwin-x64',
    layout: 'signed'
  },
  {
    tupleId: 'darwin-arm64',
    artifactName: 'ssh-relay-runtime-signed-darwin-arm64',
    layout: 'signed'
  },
  {
    tupleId: 'win32-x64',
    artifactName: 'ssh-relay-runtime-signed-win32-x64',
    layout: 'signed'
  },
  {
    tupleId: 'win32-arm64',
    artifactName: 'ssh-relay-runtime-signed-win32-arm64',
    layout: 'signed'
  }
])

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`SSH relay runtime manifest artifact ${label} must be an object`)
  }
}

function assertExactFields(value, fields, label) {
  assertObject(value, label)
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`SSH relay runtime manifest artifact ${label} has invalid fields`)
  }
}

function stableState(before, after) {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  )
}

async function realDirectory(path, label) {
  const metadata = await lstat(path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`SSH relay runtime manifest artifact ${label} must be a real directory`)
  }
  return resolve(path)
}

async function readStableJson(path, label, signal) {
  signal?.throwIfAborted()
  const before = await lstat(path, { bigint: true })
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size <= 0n ||
    before.size > BigInt(MAX_RECEIPT_BYTES)
  ) {
    throw new Error(`SSH relay runtime manifest artifact ${label} must be bounded regular JSON`)
  }
  const bytes = await readFile(path, { signal })
  const after = await lstat(path, { bigint: true })
  if (!stableState(before, after)) {
    throw new Error(`SSH relay runtime manifest artifact ${label} changed while reading`)
  }
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new Error(
      `SSH relay runtime manifest artifact ${label} is invalid JSON: ${error.message}`
    )
  }
}

function normalizeFile(value, label) {
  assertExactFields(value, FILE_FIELDS, label)
  if (
    typeof value.name !== 'string' ||
    basename(value.name) !== value.name ||
    !SAFE_NAME.test(value.name)
  ) {
    throw new Error(`SSH relay runtime manifest artifact ${label} has an unsafe name`)
  }
  if (!DIGEST.test(value.sha256)) {
    throw new Error(`SSH relay runtime manifest artifact ${label} has an invalid SHA-256`)
  }
  if (!Number.isSafeInteger(value.size) || value.size <= 0) {
    throw new Error(`SSH relay runtime manifest artifact ${label} has an invalid size`)
  }
  return { name: value.name, sha256: value.sha256, size: value.size }
}

function normalizeAggregateInput(value, expectedTupleId) {
  assertExactFields(value, INPUT_FIELDS, `${expectedTupleId} aggregate input`)
  if (value.tupleId !== expectedTupleId) {
    throw new Error(`SSH relay runtime manifest artifact receipt tuple drifted: ${expectedTupleId}`)
  }
  return {
    tupleId: expectedTupleId,
    descriptor: normalizeFile(value.descriptor, `${expectedTupleId} descriptor`),
    archive: normalizeFile(value.archive, `${expectedTupleId} archive`),
    sbom: normalizeFile(value.sbom, `${expectedTupleId} SBOM`),
    provenance: normalizeFile(value.provenance, `${expectedTupleId} provenance`)
  }
}

function receiptBinding(receipt, artifact) {
  assertObject(receipt, `${artifact.tupleId} finalization receipt`)
  if (receipt.tupleId !== artifact.tupleId) {
    throw new Error(
      `SSH relay runtime manifest artifact receipt tuple drifted: ${artifact.tupleId}`
    )
  }
  const contentId = artifact.layout === 'flat' ? receipt.contentId : receipt.finalContentId
  if (!DIGEST.test(contentId ?? '')) {
    throw new Error(
      `SSH relay runtime manifest artifact receipt content drifted: ${artifact.tupleId}`
    )
  }
  return {
    tupleId: artifact.tupleId,
    contentId,
    aggregateInput: normalizeAggregateInput(receipt.aggregateInput, artifact.tupleId)
  }
}

async function copyStableFile(source, destination, file, signal) {
  signal?.throwIfAborted()
  const before = await lstat(source, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(
      `SSH relay runtime manifest artifact input is not the declared regular file: ${file.name}`
    )
  }
  if (before.size !== BigInt(file.size)) {
    throw new Error(`SSH relay runtime manifest artifact input size mismatch: ${file.name}`)
  }
  await copyFile(source, destination, constants.COPYFILE_EXCL)
  const after = await lstat(source, { bigint: true })
  if (!stableState(before, after)) {
    throw new Error(`SSH relay runtime manifest artifact input changed while copying: ${file.name}`)
  }
}

async function assertExactArtifactDirectories(root) {
  const entries = await readdir(root, { withFileTypes: true })
  const actual = entries.map((entry) => entry.name).sort()
  const expected = SSH_RELAY_RUNTIME_MANIFEST_ARTIFACTS.map(
    ({ artifactName }) => artifactName
  ).sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      'SSH relay runtime manifest artifact root has missing or unexpected directories'
    )
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`SSH relay runtime manifest artifact is not a real directory: ${entry.name}`)
    }
  }
}

export async function collectSshRelayRuntimeManifestArtifacts({
  artifactsDirectory,
  stagingDirectory,
  signal
}) {
  const root = await realDirectory(resolve(artifactsDirectory), 'root')
  const staging = await realDirectory(resolve(stagingDirectory), 'staging directory')
  await assertExactArtifactDirectories(root)
  const names = new Set()
  const bindings = []
  for (const artifact of SSH_RELAY_RUNTIME_MANIFEST_ARTIFACTS) {
    signal?.throwIfAborted()
    const artifactRoot = await realDirectory(
      join(root, artifact.artifactName),
      artifact.artifactName
    )
    const assetsRoot =
      artifact.layout === 'flat'
        ? artifactRoot
        : await realDirectory(join(artifactRoot, 'assets'), `${artifact.tupleId} assets`)
    const evidenceRoot =
      artifact.layout === 'flat'
        ? artifactRoot
        : await realDirectory(join(artifactRoot, 'evidence'), `${artifact.tupleId} evidence`)
    const suffix = artifact.layout === 'flat' ? 'linux-finalization' : 'finalization'
    const receipt = await readStableJson(
      join(evidenceRoot, `${artifact.tupleId}.${suffix}.json`),
      `${artifact.tupleId} receipt`,
      signal
    )
    const binding = receiptBinding(receipt, artifact)
    for (const file of [
      binding.aggregateInput.descriptor,
      binding.aggregateInput.archive,
      binding.aggregateInput.sbom,
      binding.aggregateInput.provenance
    ]) {
      if (names.has(file.name)) {
        throw new Error(`SSH relay runtime manifest artifact has a duplicate file: ${file.name}`)
      }
      names.add(file.name)
      await copyStableFile(join(assetsRoot, file.name), join(staging, file.name), file, signal)
    }
    bindings.push(binding)
  }
  return bindings
}
