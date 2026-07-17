import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { collectSshRelayRuntimeManifestArtifacts } from './ssh-relay-runtime-manifest-artifact-collection.mjs'
import {
  finalizeSshRelayRuntimeManifestAggregate,
  prepareSshRelayRuntimeManifestAggregate
} from './ssh-relay-runtime-manifest-aggregate.mjs'
import {
  decodeSshRelayRuntimeManifestSigningRequestArtifact,
  encodeSshRelayRuntimeManifestSigningRequestArtifact
} from './ssh-relay-runtime-manifest-seed-signing.mjs'
import { sshRelayRuntimeManifestKeyId } from './ssh-relay-runtime-manifest-signing-handoff.mjs'

const MAX_JSON_BYTES = 48 * 1024 * 1024
const SOURCE_SHA = /^[0-9a-f]{40}$/u
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u
const DIGEST = /^sha256:[0-9a-f]{64}$/u
const PREPARED_FIELDS = [
  'acceptedKeysSha256',
  'createdAt',
  'inputTuples',
  'inputTuplesSha256',
  'relayProtocolVersion',
  'releaseTag',
  'schemaVersion',
  'signingRequest',
  'sourceSha',
  'unsignedManifest'
]

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`SSH relay runtime manifest aggregate command ${label} must be an object`)
  }
}

function assertExactFields(value, fields, label) {
  assertObject(value, label)
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`SSH relay runtime manifest aggregate command ${label} has invalid fields`)
  }
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function canonicalJson(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
}

function parseReleaseTag(tag) {
  for (const [pattern, channel] of [
    [/^v(\d+\.\d+\.\d+)$/u, 'stable'],
    [/^v(\d+\.\d+\.\d+-rc\.\d+)$/u, 'rc'],
    [/^v(\d+\.\d+\.\d+-rc\.\d+\.perf)$/u, 'perf']
  ]) {
    const match = pattern.exec(tag)
    if (match) {
      return { tag, version: match[1], channel }
    }
  }
  throw new Error('SSH relay runtime manifest aggregate command release tag is invalid')
}

function commandIdentity(input) {
  if (!SOURCE_SHA.test(input.sourceSha ?? '')) {
    throw new Error('SSH relay runtime manifest aggregate command source SHA is invalid')
  }
  const release = parseReleaseTag(input.releaseTag)
  if (
    typeof input.createdAt !== 'string' ||
    !TIMESTAMP.test(input.createdAt) ||
    new Date(input.createdAt).toISOString() !== input.createdAt
  ) {
    throw new Error('SSH relay runtime manifest aggregate command timestamp is invalid')
  }
  if (!Number.isSafeInteger(input.relayProtocolVersion) || input.relayProtocolVersion <= 0) {
    throw new Error('SSH relay runtime manifest aggregate command protocol version is invalid')
  }
  return {
    sourceSha: input.sourceSha,
    releaseTag: input.releaseTag,
    createdAt: input.createdAt,
    relayProtocolVersion: input.relayProtocolVersion,
    build: { ...release, relayProtocolVersion: input.relayProtocolVersion }
  }
}

async function readBoundedJson(path, label) {
  const before = await lstat(path, { bigint: true })
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size <= 0n ||
    before.size > BigInt(MAX_JSON_BYTES)
  ) {
    throw new Error(
      `SSH relay runtime manifest aggregate command ${label} must be bounded regular JSON`
    )
  }
  try {
    const bytes = await readFile(path)
    const after = await lstat(path, { bigint: true })
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error('file changed while reading')
    }
    return JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new Error(
      `SSH relay runtime manifest aggregate command ${label} is invalid JSON: ${error.message}`
    )
  }
}

function decodeCanonicalBase64(value, label, expectedSize) {
  if (typeof value !== 'string' || !BASE64.test(value)) {
    throw new Error(`SSH relay runtime manifest aggregate command ${label} is not canonical base64`)
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length !== expectedSize || bytes.toString('base64') !== value) {
    throw new Error(
      `SSH relay runtime manifest aggregate command ${label} must contain ${expectedSize} bytes`
    )
  }
  return bytes
}

async function readAcceptedKeys(path) {
  const document = await readBoundedJson(resolve(path), 'accepted keys')
  assertExactFields(document, ['keys', 'schemaVersion'], 'accepted keys')
  if (
    document.schemaVersion !== 1 ||
    !Array.isArray(document.keys) ||
    document.keys.length === 0 ||
    document.keys.length > 4
  ) {
    throw new Error('SSH relay runtime manifest aggregate command accepted keys are invalid')
  }
  const seen = new Set()
  const artifactKeys = document.keys
    .map((key, index) => {
      assertExactFields(key, ['keyId', 'publicKeyBase64'], `accepted key ${index}`)
      const publicKey = decodeCanonicalBase64(key.publicKeyBase64, 'accepted public key', 32)
      const keyId = sshRelayRuntimeManifestKeyId(publicKey)
      if (!DIGEST.test(key.keyId ?? '') || key.keyId !== keyId || seen.has(keyId)) {
        throw new Error(
          'SSH relay runtime manifest aggregate command accepted key identity is invalid'
        )
      }
      seen.add(keyId)
      return { keyId, publicKeyBase64: key.publicKeyBase64, publicKey }
    })
    .sort((left, right) => (left.keyId < right.keyId ? -1 : left.keyId > right.keyId ? 1 : 0))
  const serialized = artifactKeys.map(({ keyId, publicKeyBase64 }) => ({ keyId, publicKeyBase64 }))
  return {
    acceptedKeys: artifactKeys.map(({ keyId, publicKey }) => ({ keyId, publicKey })),
    sha256: sha256(canonicalJson({ schemaVersion: 1, keys: serialized }))
  }
}

async function exclusiveOutputDirectory(outputDirectory) {
  const absolute = resolve(outputDirectory)
  const parent = resolve(await realpath(dirname(absolute)))
  const parentMetadata = await lstat(parent)
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
    throw new Error('SSH relay runtime manifest aggregate command output parent must be real')
  }
  const output = resolve(parent, basename(absolute))
  try {
    await lstat(output)
  } catch (error) {
    if (error.code === 'ENOENT') {
      return output
    }
    throw error
  }
  throw new Error(
    'SSH relay runtime manifest aggregate command requires an exclusive output directory'
  )
}

function assertReceiptBindings(bindings, prepared) {
  const tuples = new Map(prepared.unsignedManifest.tuples.map((tuple) => [tuple.tupleId, tuple]))
  for (const binding of bindings) {
    if (tuples.get(binding.tupleId)?.contentId !== binding.contentId) {
      throw new Error(
        `SSH relay runtime manifest aggregate command receipt content drifted: ${binding.tupleId}`
      )
    }
  }
}

function preparedArtifact(identity, acceptedKeysSha256, prepared) {
  return {
    schemaVersion: 1,
    sourceSha: identity.sourceSha,
    releaseTag: identity.releaseTag,
    createdAt: identity.createdAt,
    relayProtocolVersion: identity.relayProtocolVersion,
    acceptedKeysSha256,
    inputTuples: prepared.inputTuples,
    inputTuplesSha256: prepared.inputTuplesSha256,
    unsignedManifest: prepared.unsignedManifest,
    signingRequest: encodeSshRelayRuntimeManifestSigningRequestArtifact(prepared.signingRequest)
  }
}

async function collectAndPrepare(input, output, identity, signal) {
  const stagingDirectory = join(output, 'aggregate-input')
  await mkdir(stagingDirectory)
  const bindings = await collectSshRelayRuntimeManifestArtifacts({
    artifactsDirectory: input.artifactsDirectory,
    stagingDirectory,
    signal
  })
  const prepared = await prepareSshRelayRuntimeManifestAggregate({
    inputDirectory: stagingDirectory,
    build: identity.build,
    createdAt: identity.createdAt,
    tupleInputs: bindings.map(({ aggregateInput }) => aggregateInput),
    signal
  })
  assertReceiptBindings(bindings, prepared)
  return prepared
}

export async function prepareSshRelayRuntimeManifestAggregateCommand(input) {
  const identity = commandIdentity(input)
  // Why: public-key policy must be valid before canonical bytes can leave this boundary.
  const keys = await readAcceptedKeys(input.acceptedKeysPath)
  const output = await exclusiveOutputDirectory(input.outputDirectory)
  let created = false
  try {
    await mkdir(output, { mode: 0o700 })
    created = true
    const prepared = await collectAndPrepare(input, output, identity, input.signal)
    const artifact = preparedArtifact(identity, keys.sha256, prepared)
    await writeFile(join(output, 'prepared-aggregate.json'), canonicalJson(artifact), {
      flag: 'wx',
      mode: 0o600
    })
    await writeFile(join(output, 'signing-request.json'), canonicalJson(artifact.signingRequest), {
      flag: 'wx',
      mode: 0o600
    })
    await rm(join(output, 'aggregate-input'), { recursive: true, force: true })
    return prepared
  } catch (error) {
    if (created) {
      await rm(output, { recursive: true, force: true })
    }
    throw error
  }
}

function normalizePreparedArtifact(value) {
  assertExactFields(value, PREPARED_FIELDS, 'prepared aggregate')
  if (value.schemaVersion !== 1 || !DIGEST.test(value.acceptedKeysSha256 ?? '')) {
    throw new Error('SSH relay runtime manifest aggregate command prepared aggregate is invalid')
  }
  decodeSshRelayRuntimeManifestSigningRequestArtifact(value.signingRequest)
  return value
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

export async function finalizeSshRelayRuntimeManifestAggregateCommand(input) {
  const identity = commandIdentity(input)
  const keys = await readAcceptedKeys(input.acceptedKeysPath)
  const prior = normalizePreparedArtifact(
    await readBoundedJson(
      join(resolve(input.preparedDirectory), 'prepared-aggregate.json'),
      'prepared aggregate'
    )
  )
  const signingResult = await readBoundedJson(resolve(input.signingResultPath), 'signing result')
  assertExactFields(signingResult, ['keyId', 'signature'], 'signing result')
  const output = await exclusiveOutputDirectory(input.outputDirectory)
  let created = false
  try {
    await mkdir(output, { mode: 0o700 })
    created = true
    const prepared = await collectAndPrepare(input, output, identity, input.signal)
    const current = preparedArtifact(identity, keys.sha256, prepared)
    if (!sameJson(prior, current)) {
      throw new Error('SSH relay runtime manifest aggregate command prepared receipt drifted')
    }
    const finalized = finalizeSshRelayRuntimeManifestAggregate({
      prepared,
      signingResults: [signingResult],
      acceptedKeys: keys.acceptedKeys
    })
    const assets = join(output, 'assets')
    const evidence = join(output, 'evidence')
    await Promise.all([mkdir(assets), mkdir(evidence)])
    await writeFile(join(assets, finalized.manifestAsset.name), finalized.bytes, {
      flag: 'wx',
      mode: 0o600
    })
    await writeFile(
      join(evidence, 'manifest-aggregate.json'),
      canonicalJson({
        schemaVersion: 1,
        sourceSha: identity.sourceSha,
        releaseTag: identity.releaseTag,
        acceptedKeysSha256: keys.sha256,
        inputTuplesSha256: finalized.inputTuplesSha256,
        manifestAsset: finalized.manifestAsset
      }),
      { flag: 'wx', mode: 0o600 }
    )
    await rm(join(output, 'aggregate-input'), { recursive: true, force: true })
    return finalized
  } catch (error) {
    if (created) {
      await rm(output, { recursive: true, force: true })
    }
    throw error
  }
}

export function parseSshRelayRuntimeManifestAggregateCommandArguments(argv) {
  const command = argv[0]
  if (command !== 'prepare' && command !== 'finalize') {
    throw new Error('SSH relay runtime manifest aggregate command requires prepare or finalize')
  }
  const fields = new Map([
    ['--artifacts-directory', 'artifactsDirectory'],
    ['--accepted-keys', 'acceptedKeysPath'],
    ['--output-directory', 'outputDirectory'],
    ['--source-sha', 'sourceSha'],
    ['--release-tag', 'releaseTag'],
    ['--created-at', 'createdAt'],
    ['--relay-protocol-version', 'relayProtocolVersion'],
    ['--prepared-directory', 'preparedDirectory'],
    ['--signing-result', 'signingResultPath']
  ])
  const result = { command }
  for (let index = 1; index < argv.length; index += 2) {
    const field = fields.get(argv[index])
    const value = argv[index + 1]
    if (!field || !value || value.startsWith('--') || result[field]) {
      throw new Error(
        `Invalid SSH relay runtime manifest aggregate command argument: ${argv[index]}`
      )
    }
    result[field] = field === 'relayProtocolVersion' ? Number(value) : value
  }
  const required = [
    'artifactsDirectory',
    'acceptedKeysPath',
    'outputDirectory',
    'sourceSha',
    'releaseTag',
    'createdAt',
    'relayProtocolVersion'
  ]
  if (command === 'finalize') {
    required.push('preparedDirectory', 'signingResultPath')
  }
  for (const field of required) {
    if (!result[field]) {
      throw new Error(`Missing SSH relay runtime manifest aggregate command argument: ${field}`)
    }
  }
  return result
}

async function main() {
  const options = parseSshRelayRuntimeManifestAggregateCommandArguments(process.argv.slice(2))
  const operation =
    options.command === 'prepare'
      ? prepareSshRelayRuntimeManifestAggregateCommand
      : finalizeSshRelayRuntimeManifestAggregateCommand
  const result = await operation(options)
  process.stdout.write(`${JSON.stringify({ inputTuplesSha256: result.inputTuplesSha256 })}\n`)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `SSH relay runtime manifest aggregate command failed: ${error.stack ?? error}\n`
    )
    process.exitCode = 1
  })
}
