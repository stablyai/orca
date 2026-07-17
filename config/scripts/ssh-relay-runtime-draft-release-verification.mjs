import { lstat, mkdir, realpath, rm } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

import { materializeSshRelayRuntimeDraftReadback } from './ssh-relay-runtime-draft-readback.mjs'
import { uploadSshRelayRuntimeDraftAssets } from './ssh-relay-runtime-draft-upload.mjs'
import { executeSshRelayRuntimeReadbackArchive } from './ssh-relay-runtime-readback-archive-execution.mjs'

const COMPOSITION_TIMEOUT_MS = 45 * 60_000
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u
const TAG_PATTERN = /^v\d+\.\d+\.\d+(?:-rc\.\d+(?:\.[0-9A-Za-z]+)?)?$/u
const TUPLE_PATTERN = /^(?:linux-(?:x64|arm64)-glibc|darwin-(?:x64|arm64)|win32-(?:x64|arm64))$/u
const RUNTIME_ARCHIVE_PATTERN = /^orca-ssh-relay-runtime-v1-.+\.(?:tar\.br|zip)$/u
const MANAGED_ASSET_PATTERN = /^orca-ssh-relay-runtime-[A-Za-z0-9._-]+$/u
const MAX_ASSET_BYTES = 100 * 1024 * 1024
const MAX_ASSETS = 26
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`SSH relay runtime draft release verification ${label} must be an object`)
  }
}

function assertExactFields(value, fields, label) {
  assertObject(value, label)
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...fields].sort())) {
    throw new Error(`SSH relay runtime draft release verification ${label} fields drifted`)
  }
}

function sameAsset(left, right) {
  return left.name === right.name && left.sha256 === right.sha256 && left.size === right.size
}

function assetIdentity(asset, label, fields) {
  assertObject(asset, label)
  if (fields) {
    assertExactFields(asset, fields, label)
  }
  if (
    typeof asset.name !== 'string' ||
    asset.name.length === 0 ||
    typeof asset.sha256 !== 'string' ||
    !DIGEST_PATTERN.test(asset.sha256) ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    asset.size > MAX_ASSET_BYTES
  ) {
    throw new Error(`SSH relay runtime draft release verification ${label} is invalid`)
  }
  return { name: asset.name, sha256: asset.sha256, size: asset.size }
}

function validateReleaseInput({ repo, releaseId, tag, sourceCommit, token }) {
  if (
    typeof repo !== 'string' ||
    !REPOSITORY_PATTERN.test(repo) ||
    !Number.isSafeInteger(releaseId) ||
    releaseId <= 0 ||
    typeof tag !== 'string' ||
    !TAG_PATTERN.test(tag) ||
    typeof sourceCommit !== 'string' ||
    !COMMIT_PATTERN.test(sourceCommit) ||
    typeof token !== 'string' ||
    token.length === 0
  ) {
    throw new Error('SSH relay runtime draft release verification release identity is invalid')
  }
}

function expectedAssets(assets) {
  if (!Array.isArray(assets) || assets.length === 0 || assets.length > MAX_ASSETS) {
    throw new Error('SSH relay runtime draft release verification assets are required')
  }
  const byName = new Map()
  let totalBytes = 0
  for (const [index, asset] of assets.entries()) {
    const normalized = assetIdentity(asset, `asset ${index}`)
    if (
      !MANAGED_ASSET_PATTERN.test(normalized.name) ||
      typeof asset.path !== 'string' ||
      asset.path.length === 0 ||
      byName.has(normalized.name)
    ) {
      throw new Error('SSH relay runtime draft release verification asset path or name is invalid')
    }
    totalBytes += normalized.size
    byName.set(normalized.name, normalized)
  }
  if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_BYTES) {
    throw new Error('SSH relay runtime draft release verification assets exceed the total bound')
  }
  return byName
}

function expectedArchiveIdentities(archiveIdentities, assetsByName) {
  if (!Array.isArray(archiveIdentities) || archiveIdentities.length === 0) {
    throw new Error('SSH relay runtime draft release verification archive identities are required')
  }
  const tuples = new Set()
  const archives = new Set()
  const normalized = archiveIdentities.map((identity, index) => {
    assertObject(identity, `archive identity ${index}`)
    assertObject(identity.archive, `archive identity ${index} archive`)
    const archive = assetIdentity(identity.archive, `archive identity ${index} archive`)
    const expected = assetsByName.get(archive.name)
    if (
      typeof identity.tupleId !== 'string' ||
      !TUPLE_PATTERN.test(identity.tupleId) ||
      typeof identity.contentId !== 'string' ||
      !DIGEST_PATTERN.test(identity.contentId) ||
      !expected ||
      !sameAsset(archive, expected) ||
      tuples.has(identity.tupleId) ||
      archives.has(archive.name)
    ) {
      throw new Error('SSH relay runtime draft release verification archive identity drifted')
    }
    tuples.add(identity.tupleId)
    archives.add(archive.name)
    return { identity, archive }
  })
  const expectedArchiveNames = [...assetsByName.keys()].filter((name) =>
    RUNTIME_ARCHIVE_PATTERN.test(name)
  )
  if (
    expectedArchiveNames.length !== archives.size ||
    expectedArchiveNames.some((name) => !archives.has(name))
  ) {
    throw new Error('SSH relay runtime draft release verification archive coverage drifted')
  }
  return normalized
}

async function exclusivePhysicalDirectory(path, label) {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error(`SSH relay runtime draft release verification ${label} is required`)
  }
  const absolute = resolve(path)
  const physicalParent = resolve(await realpath(dirname(absolute)))
  const physical = resolve(physicalParent, basename(absolute))
  try {
    await lstat(physical)
  } catch (error) {
    if (error.code === 'ENOENT') {
      return physical
    }
    throw error
  }
  throw new Error(
    `SSH relay runtime draft release verification ${label} must be an exclusive absent directory`
  )
}

function containsPath(parent, candidate) {
  const path = relative(parent, candidate)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`))
}

function assertDisjointOutputs(readbackDirectory, executionDirectory) {
  if (
    containsPath(readbackDirectory, executionDirectory) ||
    containsPath(executionDirectory, readbackDirectory)
  ) {
    throw new Error(
      'SSH relay runtime draft release verification output directories must be disjoint'
    )
  }
}

function validateUploadResult(result, expected, { releaseId, tag, sourceCommit }) {
  assertExactFields(
    result,
    ['releaseId', 'reusedAssets', 'sourceCommit', 'tag', 'uploadedAssets'],
    'upload result'
  )
  if (
    result.releaseId !== releaseId ||
    result.tag !== tag ||
    result.sourceCommit !== sourceCommit ||
    !Array.isArray(result.reusedAssets) ||
    !Array.isArray(result.uploadedAssets)
  ) {
    throw new Error('SSH relay runtime draft release verification upload identity drifted')
  }
  const returned = [...result.reusedAssets, ...result.uploadedAssets]
  const names = new Set()
  for (const [index, asset] of returned.entries()) {
    const normalized = assetIdentity(asset, `upload result asset ${index}`, [
      'name',
      'sha256',
      'size'
    ])
    const expectedAsset = expected.get(normalized.name)
    if (!expectedAsset || !sameAsset(normalized, expectedAsset) || names.has(normalized.name)) {
      throw new Error('SSH relay runtime draft release verification upload assets drifted')
    }
    names.add(normalized.name)
  }
  if (names.size !== expected.size) {
    throw new Error('SSH relay runtime draft release verification upload asset coverage drifted')
  }
}

function validateMaterializationResult(result, expected, { releaseId, tag, readbackDirectory }) {
  assertExactFields(result, ['materializedAssets', 'releaseId', 'tag'], 'read-back result')
  if (
    result.releaseId !== releaseId ||
    result.tag !== tag ||
    !Array.isArray(result.materializedAssets)
  ) {
    throw new Error('SSH relay runtime draft release verification read-back identity drifted')
  }
  const returned = new Map()
  for (const [index, asset] of result.materializedAssets.entries()) {
    const normalized = assetIdentity(asset, `materialized asset ${index}`, [
      'name',
      'path',
      'sha256',
      'size'
    ])
    const expectedAsset = expected.get(normalized.name)
    if (
      !expectedAsset ||
      !sameAsset(normalized, expectedAsset) ||
      returned.has(normalized.name) ||
      asset.path !== join(readbackDirectory, normalized.name)
    ) {
      throw new Error('SSH relay runtime draft release verification materialized assets drifted')
    }
    returned.set(normalized.name, { ...normalized, path: asset.path })
  }
  if (returned.size !== expected.size) {
    throw new Error('SSH relay runtime draft release verification materialized coverage drifted')
  }
  return returned
}

function validateExecutionResult(result, identity, outputDirectory) {
  assertObject(result, 'archive execution result')
  if (
    result.tupleId !== identity.tupleId ||
    result.contentId !== identity.contentId ||
    result.runtimeRoot !== outputDirectory ||
    result.smoke === null ||
    typeof result.smoke !== 'object'
  ) {
    throw new Error('SSH relay runtime draft release verification execution identity drifted')
  }
  return result
}

async function removeFailedOutputs(error, directories) {
  const cleanup = await Promise.allSettled(
    directories.map((directory) => rm(directory, { recursive: true, force: true }))
  )
  const cleanupFailures = cleanup
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason)
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      [error, ...cleanupFailures],
      'SSH relay runtime draft release verification failed and cleanup was incomplete'
    )
  }
  throw error
}

export async function verifySshRelayRuntimeDraftReleaseTransaction({
  repo,
  releaseId,
  tag,
  sourceCommit,
  token,
  assets,
  archiveIdentities,
  readbackDirectory,
  executionDirectory,
  signal,
  uploadImpl = uploadSshRelayRuntimeDraftAssets,
  materializeImpl = materializeSshRelayRuntimeDraftReadback,
  executeImpl = executeSshRelayRuntimeReadbackArchive
}) {
  const effectiveSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(COMPOSITION_TIMEOUT_MS)])
    : AbortSignal.timeout(COMPOSITION_TIMEOUT_MS)
  effectiveSignal.throwIfAborted()
  validateReleaseInput({ repo, releaseId, tag, sourceCommit, token })
  const assetsByName = expectedAssets(assets)
  const archives = expectedArchiveIdentities(archiveIdentities, assetsByName)
  const [physicalReadback, physicalExecution] = await Promise.all([
    exclusivePhysicalDirectory(readbackDirectory, 'read-back directory'),
    exclusivePhysicalDirectory(executionDirectory, 'execution directory')
  ])
  assertDisjointOutputs(physicalReadback, physicalExecution)

  let readbackOwned = false
  let executionOwned = false
  try {
    const upload = await uploadImpl({
      repo,
      releaseId,
      tag,
      sourceCommit,
      token,
      assets,
      signal: effectiveSignal
    })
    effectiveSignal.throwIfAborted()
    validateUploadResult(upload, assetsByName, { releaseId, tag, sourceCommit })

    const materialization = await materializeImpl({
      repo,
      releaseId,
      tag,
      token,
      expectedAssets: [...assetsByName.values()],
      outputDirectory: physicalReadback,
      signal: effectiveSignal
    })
    readbackOwned = true
    effectiveSignal.throwIfAborted()
    const materialized = validateMaterializationResult(materialization, assetsByName, {
      releaseId,
      tag,
      readbackDirectory: physicalReadback
    })

    await mkdir(physicalExecution, { mode: 0o700 })
    executionOwned = true
    const verifiedRuntimes = []
    for (const { identity, archive } of archives) {
      effectiveSignal.throwIfAborted()
      const outputDirectory = join(physicalExecution, identity.tupleId)
      const result = await executeImpl({
        identity,
        materializedArchive: materialized.get(archive.name),
        outputDirectory,
        signal: effectiveSignal
      })
      effectiveSignal.throwIfAborted()
      verifiedRuntimes.push(validateExecutionResult(result, identity, outputDirectory))
    }
    return {
      releaseId,
      tag,
      sourceCommit,
      readbackDirectory: physicalReadback,
      executionDirectory: physicalExecution,
      verifiedRuntimes
    }
  } catch (error) {
    // Why: no later release phase may observe bytes from a partially verified transaction.
    return removeFailedOutputs(error, [
      ...(readbackOwned ? [physicalReadback] : []),
      ...(executionOwned ? [physicalExecution] : [])
    ])
  }
}

export const SSH_RELAY_RUNTIME_DRAFT_RELEASE_VERIFICATION_LIMITS = Object.freeze({
  maximumAssetBytes: MAX_ASSET_BYTES,
  maximumAssets: MAX_ASSETS,
  maximumTotalBytes: MAX_TOTAL_BYTES,
  timeoutMs: COMPOSITION_TIMEOUT_MS
})
