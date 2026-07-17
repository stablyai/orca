import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { verifySshRelayRuntimeAggregateFiles } from './ssh-relay-runtime-aggregate-input.mjs'
import { assembleCanonicalSshRelayRuntimeManifest } from './ssh-relay-runtime-manifest-assembly.mjs'
import {
  createSshRelayRuntimeManifestSigningRequest,
  finalizeSshRelayRuntimeManifestSigningHandoff
} from './ssh-relay-runtime-manifest-signing-handoff.mjs'
import { sshRelayRuntimeCompatibility } from './ssh-relay-runtime-compatibility.mjs'

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u
const ASSET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/u
const MAX_TUPLES = 8
const MAX_METADATA_BYTES = 32 * 1024 * 1024
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024
const AGGREGATE_TIMEOUT_MS = 15 * 60_000
const INPUT_FIELDS = ['archive', 'descriptor', 'provenance', 'sbom', 'tupleId']
const FILE_FIELDS = ['name', 'sha256', 'size']
const PREPARED_FIELDS = ['inputTuples', 'inputTuplesSha256', 'signingRequest', 'unsignedManifest']

export const SSH_RELAY_RUNTIME_MANIFEST_AGGREGATE_LIMITS = Object.freeze({
  maximumTuples: MAX_TUPLES,
  maximumMetadataBytes: MAX_METADATA_BYTES,
  timeoutMs: AGGREGATE_TIMEOUT_MS
})

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`SSH relay runtime manifest aggregate ${label} must be an object`)
  }
}

function assertExactFields(value, fields, label) {
  assertObject(value, label)
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(
      `SSH relay runtime manifest aggregate ${label} has unexpected or missing fields`
    )
  }
}

function normalizeFile(value, label, maximumSize) {
  assertExactFields(value, FILE_FIELDS, label)
  if (typeof value.name !== 'string' || !ASSET_NAME_PATTERN.test(value.name)) {
    throw new Error(`SSH relay runtime manifest aggregate ${label} has an invalid name`)
  }
  if (!DIGEST_PATTERN.test(value.sha256)) {
    throw new Error(`SSH relay runtime manifest aggregate ${label} has an invalid SHA-256`)
  }
  if (!Number.isSafeInteger(value.size) || value.size <= 0 || value.size > maximumSize) {
    throw new Error(`SSH relay runtime manifest aggregate ${label} exceeds its size limit`)
  }
  return { name: value.name, size: value.size, sha256: value.sha256 }
}

function normalizeTupleInputs(tupleInputs) {
  if (!Array.isArray(tupleInputs) || tupleInputs.length === 0 || tupleInputs.length > MAX_TUPLES) {
    throw new Error('SSH relay runtime manifest aggregate tuple inputs must be a bounded array')
  }
  const tupleIds = new Set()
  return tupleInputs
    .map((input, index) => {
      assertExactFields(input, INPUT_FIELDS, `tuple input ${index}`)
      if (!Object.hasOwn(sshRelayRuntimeCompatibility, input.tupleId)) {
        throw new Error(
          `SSH relay runtime manifest aggregate has an unsupported tuple: ${input.tupleId}`
        )
      }
      if (tupleIds.has(input.tupleId)) {
        throw new Error(
          `SSH relay runtime manifest aggregate has a duplicate tuple: ${input.tupleId}`
        )
      }
      tupleIds.add(input.tupleId)
      const descriptor = normalizeFile(
        input.descriptor,
        `${input.tupleId} descriptor`,
        MAX_METADATA_BYTES
      )
      if (descriptor.name !== `orca-ssh-relay-runtime-${input.tupleId}.manifest-tuple.json`) {
        throw new Error(
          `SSH relay runtime manifest aggregate ${input.tupleId} descriptor has an unexpected name`
        )
      }
      return {
        tupleId: input.tupleId,
        descriptor,
        archive: normalizeFile(input.archive, `${input.tupleId} archive`, MAX_ARCHIVE_BYTES),
        sbom: normalizeFile(input.sbom, `${input.tupleId} SBOM`, MAX_METADATA_BYTES),
        provenance: normalizeFile(
          input.provenance,
          `${input.tupleId} provenance`,
          MAX_METADATA_BYTES
        )
      }
    })
    .sort((left, right) =>
      left.tupleId < right.tupleId ? -1 : left.tupleId > right.tupleId ? 1 : 0
    )
}

function flattenFiles(tupleInputs) {
  return tupleInputs.flatMap(({ descriptor, archive, sbom, provenance }) => [
    descriptor,
    archive,
    sbom,
    provenance
  ])
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function inputTuplesSha256(tupleInputs) {
  return sha256(Buffer.from(JSON.stringify(tupleInputs), 'utf8'))
}

function decodeDescriptor(bytes, input) {
  if (bytes.length !== input.descriptor.size || sha256(bytes) !== input.descriptor.sha256) {
    throw new Error(
      `SSH relay runtime manifest aggregate descriptor bytes changed: ${input.descriptor.name}`
    )
  }
  let source
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error(
      `SSH relay runtime manifest aggregate descriptor must be valid UTF-8: ${input.descriptor.name}`
    )
  }
  let descriptor
  try {
    descriptor = JSON.parse(source)
  } catch {
    throw new Error(
      `SSH relay runtime manifest aggregate descriptor must be valid JSON: ${input.descriptor.name}`
    )
  }
  assertExactFields(descriptor, ['schemaVersion', 'tuple'], `${input.tupleId} descriptor`)
  if (descriptor.schemaVersion !== 1) {
    throw new Error(
      `SSH relay runtime manifest aggregate ${input.tupleId} descriptor schema is unsupported`
    )
  }
  assertObject(descriptor.tuple, `${input.tupleId} descriptor tuple`)
  if (descriptor.tuple.tupleId !== input.tupleId) {
    throw new Error(
      `SSH relay runtime manifest aggregate ${input.tupleId} descriptor has the wrong tuple`
    )
  }
  return descriptor.tuple
}

function sameFile(actual, expected) {
  return (
    actual?.name === expected.name &&
    actual?.size === expected.size &&
    actual?.sha256 === expected.sha256
  )
}

function assertTupleAssets(tuple, input) {
  if (!sameFile(tuple.archive, input.archive)) {
    throw new Error(
      `SSH relay runtime manifest aggregate ${input.tupleId} archive disagrees with its descriptor`
    )
  }
  if (!sameFile(tuple.metadataAssets?.sbom, input.sbom)) {
    throw new Error(
      `SSH relay runtime manifest aggregate ${input.tupleId} SBOM disagrees with its descriptor`
    )
  }
  if (!sameFile(tuple.metadataAssets?.provenance, input.provenance)) {
    throw new Error(
      `SSH relay runtime manifest aggregate ${input.tupleId} provenance disagrees with its descriptor`
    )
  }
}

async function readTuples(inputDirectory, tupleInputs, signal) {
  const root = resolve(inputDirectory)
  const tuples = []
  for (const input of tupleInputs) {
    signal?.throwIfAborted()
    // Why: only the independently hashed post-sign descriptor may supply manifest identity/trust.
    const bytes = await readFile(join(root, input.descriptor.name), { signal })
    const tuple = decodeDescriptor(bytes, input)
    assertTupleAssets(tuple, input)
    tuples.push(tuple)
  }
  return tuples
}

function assertPreparedBindings(prepared, tupleInputs, assembled) {
  if (prepared.inputTuplesSha256 !== inputTuplesSha256(tupleInputs)) {
    throw new Error('SSH relay runtime manifest aggregate prepared input receipt drifted')
  }
  if (assembled.manifest.tuples.length !== tupleInputs.length) {
    throw new Error('SSH relay runtime manifest aggregate prepared tuple count drifted')
  }
  for (const [index, input] of tupleInputs.entries()) {
    const tuple = assembled.manifest.tuples[index]
    if (tuple.tupleId !== input.tupleId) {
      throw new Error('SSH relay runtime manifest aggregate prepared tuple identity drifted')
    }
    assertTupleAssets(tuple, input)
  }
  const expectedRequest = createSshRelayRuntimeManifestSigningRequest(assembled.canonicalBytes)
  assertExactFields(
    prepared.signingRequest,
    Object.keys(expectedRequest),
    'prepared signing request'
  )
  if (
    prepared.signingRequest.algorithm !== expectedRequest.algorithm ||
    prepared.signingRequest.payloadSize !== expectedRequest.payloadSize ||
    prepared.signingRequest.payloadSha256 !== expectedRequest.payloadSha256 ||
    !Buffer.from(prepared.signingRequest.canonicalBytes).equals(expectedRequest.canonicalBytes)
  ) {
    throw new Error('SSH relay runtime manifest aggregate prepared signing request drifted')
  }
}

export async function prepareSshRelayRuntimeManifestAggregate({
  inputDirectory,
  build,
  createdAt,
  tupleInputs,
  signal
}) {
  const effectiveSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(AGGREGATE_TIMEOUT_MS)])
    : AbortSignal.timeout(AGGREGATE_TIMEOUT_MS)
  effectiveSignal.throwIfAborted()
  const normalizedInputs = normalizeTupleInputs(tupleInputs)
  // Why: an extra or omitted file must fail before any descriptor can influence signed content.
  await verifySshRelayRuntimeAggregateFiles({
    inputDirectory,
    files: flattenFiles(normalizedInputs),
    signal: effectiveSignal
  })
  const tuples = await readTuples(inputDirectory, normalizedInputs, effectiveSignal)
  const assembled = assembleCanonicalSshRelayRuntimeManifest({
    schemaVersion: 1,
    build,
    createdAt,
    tuples
  })
  return {
    inputTuples: normalizedInputs,
    inputTuplesSha256: inputTuplesSha256(normalizedInputs),
    unsignedManifest: assembled.manifest,
    signingRequest: createSshRelayRuntimeManifestSigningRequest(assembled.canonicalBytes)
  }
}

export function finalizeSshRelayRuntimeManifestAggregate({
  prepared,
  signingResults,
  acceptedKeys
}) {
  assertExactFields(prepared, PREPARED_FIELDS, 'prepared result')
  const tupleInputs = normalizeTupleInputs(prepared.inputTuples)
  // Why: finalization reassembles the verified projection so mutable handoff objects cannot drift.
  const assembled = assembleCanonicalSshRelayRuntimeManifest(prepared.unsignedManifest)
  assertPreparedBindings(prepared, tupleInputs, assembled)
  const finalized = finalizeSshRelayRuntimeManifestSigningHandoff({
    request: prepared.signingRequest,
    signingResults,
    acceptedKeys
  })
  const manifestAsset = {
    name: 'orca-ssh-relay-runtime-manifest.json',
    size: finalized.bytes.length,
    sha256: finalized.sha256
  }
  return {
    inputTuples: tupleInputs,
    inputTuplesSha256: prepared.inputTuplesSha256,
    manifest: finalized.manifest,
    bytes: finalized.bytes,
    sha256: finalized.sha256,
    manifestAsset
  }
}
