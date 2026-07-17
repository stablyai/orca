import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

import { sshRelayRuntimeCompatibility } from './ssh-relay-runtime-compatibility.mjs'

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u
const ASSET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/u
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024
const MAX_TUPLES = 8
// Why: each tuple contributes only its descriptor, archive, SBOM, and provenance to this boundary.
const MAX_INPUT_FILES = MAX_TUPLES * 4
const MAX_INPUT_BYTES = 1024 * 1024 * 1024
const AGGREGATE_TIMEOUT_MS = 15 * 60_000
const ASSET_FIELDS = ['tupleId', 'name', 'contentId', 'sha256', 'size']
const FILE_FIELDS = ['name', 'sha256', 'size']

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`SSH relay runtime aggregate ${label} must be an object`)
  }
}

function assertExactFields(value, fields, label) {
  assertObject(value, label)
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`SSH relay runtime aggregate ${label} has unexpected or missing fields`)
  }
}

function expectedArchiveName(tupleId, contentId) {
  const digest = contentId.slice('sha256:'.length)
  const extension = tupleId.startsWith('win32-') ? 'zip' : 'tar.br'
  return `orca-ssh-relay-runtime-v1-${tupleId}-${digest}.${extension}`
}

function normalizeAssets(assets) {
  if (!Array.isArray(assets) || assets.length === 0 || assets.length > MAX_TUPLES) {
    throw new Error('SSH relay runtime aggregate assets must be a bounded non-empty array')
  }
  const tupleIds = new Set()
  const names = new Set()
  return assets.map((asset, index) => {
    assertExactFields(asset, ASSET_FIELDS, `asset ${index}`)
    if (!Object.hasOwn(sshRelayRuntimeCompatibility, asset.tupleId)) {
      throw new Error(`SSH relay runtime aggregate has an unsupported tuple: ${asset.tupleId}`)
    }
    if (tupleIds.has(asset.tupleId)) {
      throw new Error(`SSH relay runtime aggregate has a duplicate tuple: ${asset.tupleId}`)
    }
    tupleIds.add(asset.tupleId)
    if (typeof asset.name !== 'string' || !ASSET_NAME_PATTERN.test(asset.name)) {
      throw new Error('SSH relay runtime aggregate asset has an invalid name')
    }
    if (names.has(asset.name)) {
      throw new Error(`SSH relay runtime aggregate has a duplicate asset: ${asset.name}`)
    }
    names.add(asset.name)
    if (!DIGEST_PATTERN.test(asset.contentId)) {
      throw new Error('SSH relay runtime aggregate asset has an invalid content identity')
    }
    if (!DIGEST_PATTERN.test(asset.sha256)) {
      throw new Error('SSH relay runtime aggregate asset has an invalid SHA-256')
    }
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_ARCHIVE_BYTES) {
      throw new Error('SSH relay runtime aggregate asset has an invalid size')
    }
    if (asset.name !== expectedArchiveName(asset.tupleId, asset.contentId)) {
      throw new Error(`SSH relay runtime aggregate archive name is inconsistent: ${asset.name}`)
    }
    return { ...asset }
  })
}

function normalizeFiles(files) {
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_INPUT_FILES) {
    throw new Error('SSH relay runtime aggregate files must be a bounded non-empty array')
  }
  const names = new Set()
  let totalSize = 0
  return files.map((file, index) => {
    assertExactFields(file, FILE_FIELDS, `file ${index}`)
    if (typeof file.name !== 'string' || !ASSET_NAME_PATTERN.test(file.name)) {
      throw new Error('SSH relay runtime aggregate file has an invalid name')
    }
    if (names.has(file.name)) {
      throw new Error(`SSH relay runtime aggregate has a duplicate file: ${file.name}`)
    }
    names.add(file.name)
    if (!DIGEST_PATTERN.test(file.sha256)) {
      throw new Error('SSH relay runtime aggregate file has an invalid SHA-256')
    }
    if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_ARCHIVE_BYTES) {
      throw new Error('SSH relay runtime aggregate file has an invalid size')
    }
    totalSize += file.size
    if (!Number.isSafeInteger(totalSize) || totalSize > MAX_INPUT_BYTES) {
      throw new Error('SSH relay runtime aggregate files exceed the total size limit')
    }
    return { ...file }
  })
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

async function hashFile(path, file, signal) {
  signal?.throwIfAborted()
  const before = await lstat(path, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`SSH relay runtime aggregate input is not a regular file: ${file.name}`)
  }
  if (before.size !== BigInt(file.size)) {
    throw new Error(`SSH relay runtime aggregate input size mismatch: ${file.name}`)
  }
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(path, { signal })) {
    signal?.throwIfAborted()
    bytes += chunk.length
    if (bytes > file.size) {
      throw new Error(`SSH relay runtime aggregate input exceeded its size: ${file.name}`)
    }
    hash.update(chunk)
  }
  const after = await lstat(path, { bigint: true })
  // Why: aggregate identity must describe one stable file, not bytes swapped during hashing.
  if (!sameFileState(before, after)) {
    throw new Error(`SSH relay runtime aggregate input changed while hashing: ${file.name}`)
  }
  if (bytes !== file.size) {
    throw new Error(`SSH relay runtime aggregate input size mismatch: ${file.name}`)
  }
  const digest = `sha256:${hash.digest('hex')}`
  if (digest !== file.sha256) {
    throw new Error(`SSH relay runtime aggregate input SHA-256 mismatch: ${file.name}`)
  }
}

export async function verifySshRelayRuntimeAggregateFiles({ inputDirectory, files, signal }) {
  const effectiveSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(AGGREGATE_TIMEOUT_MS)])
    : AbortSignal.timeout(AGGREGATE_TIMEOUT_MS)
  effectiveSignal.throwIfAborted()
  if (typeof inputDirectory !== 'string' || inputDirectory.length === 0) {
    throw new Error('SSH relay runtime aggregate input directory is required')
  }
  const normalized = normalizeFiles(files)
  const root = resolve(inputDirectory)
  const rootMetadata = await lstat(root)
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error('SSH relay runtime aggregate input root must be a real directory')
  }
  const entries = await readdir(root, { withFileTypes: true })
  const actualNames = entries.map((entry) => entry.name).sort()
  const expectedNames = normalized.map((file) => file.name).sort()
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error('SSH relay runtime aggregate input directory has missing or unexpected files')
  }
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`SSH relay runtime aggregate input is not a regular file: ${entry.name}`)
    }
  }
  for (const file of normalized) {
    const path = join(root, file.name)
    if (basename(path) !== file.name) {
      throw new Error(`SSH relay runtime aggregate file path is unsafe: ${file.name}`)
    }
    await hashFile(path, file, effectiveSignal)
  }
  return normalized
}

export async function verifySshRelayRuntimeAggregateInputs({ inputDirectory, assets, signal }) {
  const normalized = normalizeAssets(assets)
  await verifySshRelayRuntimeAggregateFiles({
    inputDirectory,
    files: normalized.map(({ name, sha256, size }) => ({ name, sha256, size })),
    signal
  })
  return normalized
}
