import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import nacl from 'tweetnacl'

import {
  createSshRelayRuntimeManifestSigningRequest,
  sshRelayRuntimeManifestKeyId
} from './ssh-relay-runtime-manifest-signing-handoff.mjs'

const REQUEST_FIELDS = [
  'algorithm',
  'payloadBase64',
  'payloadSha256',
  'payloadSize',
  'schemaVersion'
]
const MAX_REQUEST_ARTIFACT_BYTES = 48 * 1024 * 1024
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`SSH relay runtime manifest seed signing ${label} must be an object`)
  }
}

function assertExactFields(value, fields, label) {
  assertObject(value, label)
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(
      `SSH relay runtime manifest seed signing ${label} has unexpected or missing fields`
    )
  }
}

function decodeCanonicalBase64(value, label) {
  if (typeof value !== 'string' || !BASE64_PATTERN.test(value)) {
    throw new Error(`SSH relay runtime manifest seed signing ${label} is not canonical base64`)
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length === 0 || bytes.toString('base64') !== value) {
    throw new Error(`SSH relay runtime manifest seed signing ${label} is not canonical base64`)
  }
  return bytes
}

function validateInMemoryRequest(request) {
  assertExactFields(
    request,
    ['algorithm', 'canonicalBytes', 'payloadSha256', 'payloadSize'],
    'request'
  )
  if (!Buffer.isBuffer(request.canonicalBytes) && !(request.canonicalBytes instanceof Uint8Array)) {
    throw new Error('SSH relay runtime manifest seed signing request payload must be bytes')
  }
  const expected = createSshRelayRuntimeManifestSigningRequest(request.canonicalBytes)
  if (
    request.algorithm !== expected.algorithm ||
    request.payloadSha256 !== expected.payloadSha256 ||
    request.payloadSize !== expected.payloadSize
  ) {
    throw new Error('SSH relay runtime manifest seed signing request binding is inconsistent')
  }
  return expected
}

export function encodeSshRelayRuntimeManifestSigningRequestArtifact(request) {
  const parsed = validateInMemoryRequest(request)
  return {
    schemaVersion: 1,
    algorithm: parsed.algorithm,
    payloadBase64: parsed.canonicalBytes.toString('base64'),
    payloadSha256: parsed.payloadSha256,
    payloadSize: parsed.payloadSize
  }
}

export function decodeSshRelayRuntimeManifestSigningRequestArtifact(artifact) {
  assertExactFields(artifact, REQUEST_FIELDS, 'request artifact')
  if (artifact.schemaVersion !== 1 || artifact.algorithm !== 'ed25519-v1') {
    throw new Error(
      'SSH relay runtime manifest seed signing request artifact schema is unsupported'
    )
  }
  const canonicalBytes = decodeCanonicalBase64(artifact.payloadBase64, 'request payload')
  const request = createSshRelayRuntimeManifestSigningRequest(canonicalBytes)
  if (
    artifact.payloadSize !== request.payloadSize ||
    artifact.payloadSha256 !== request.payloadSha256
  ) {
    throw new Error(
      'SSH relay runtime manifest seed signing request artifact binding is inconsistent'
    )
  }
  return request
}

function decodeSeed(seedBase64) {
  const seed = decodeCanonicalBase64(seedBase64, 'seed')
  if (seed.length !== nacl.sign.seedLength) {
    throw new Error('SSH relay runtime manifest signing seed must contain exactly 32 bytes')
  }
  return seed
}

export function signSshRelayRuntimeManifestRequest({ requestArtifact, seedBase64 }) {
  const request = decodeSshRelayRuntimeManifestSigningRequestArtifact(requestArtifact)
  const pair = nacl.sign.keyPair.fromSeed(decodeSeed(seedBase64))
  return {
    keyId: sshRelayRuntimeManifestKeyId(pair.publicKey),
    signature: Buffer.from(nacl.sign.detached(request.canonicalBytes, pair.secretKey)).toString(
      'base64'
    )
  }
}

export async function readSshRelayRuntimeManifestSigningRequestArtifact(path) {
  const metadata = await lstat(path)
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size <= 0 ||
    metadata.size > MAX_REQUEST_ARTIFACT_BYTES
  ) {
    throw new Error('SSH relay runtime manifest signing request must be a bounded regular file')
  }
  let artifact
  try {
    artifact = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(`SSH relay runtime manifest signing request is invalid JSON: ${error.message}`)
  }
  decodeSshRelayRuntimeManifestSigningRequestArtifact(artifact)
  return artifact
}

async function exclusiveOutputDirectory(outputDirectory) {
  const absolute = resolve(outputDirectory)
  const parent = resolve(await realpath(dirname(absolute)))
  const parentMetadata = await lstat(parent)
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
    throw new Error('SSH relay runtime manifest signing output parent must be a real directory')
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
    'SSH relay runtime manifest signing requires an exclusive absent output directory'
  )
}

export async function writeSshRelayRuntimeManifestSigningResult({
  requestArtifact,
  seedBase64,
  outputDirectory
}) {
  const result = signSshRelayRuntimeManifestRequest({ requestArtifact, seedBase64 })
  const output = await exclusiveOutputDirectory(outputDirectory)
  let created = false
  try {
    await mkdir(output, { mode: 0o700 })
    created = true
    // Why: the protected job may return only the authenticated key identity and detached signature.
    await writeFile(joinResultPath(output), `${JSON.stringify(result)}\n`, {
      flag: 'wx',
      mode: 0o600
    })
    return result
  } catch (error) {
    if (created) {
      await rm(output, { recursive: true, force: true })
    }
    throw error
  }
}

function joinResultPath(output) {
  return resolve(output, 'signing-result.json')
}

export function parseSshRelayRuntimeManifestSeedSigningArguments(argv) {
  const options = {}
  const fields = new Map([
    ['--request', 'requestPath'],
    ['--output-directory', 'outputDirectory']
  ])
  for (let index = 0; index < argv.length; index += 2) {
    const field = fields.get(argv[index])
    const value = argv[index + 1]
    if (!field || !value || value.startsWith('--') || options[field]) {
      throw new Error(`Invalid SSH relay runtime manifest seed signing argument: ${argv[index]}`)
    }
    options[field] = resolve(value)
  }
  for (const field of fields.values()) {
    if (!options[field]) {
      throw new Error(`Missing SSH relay runtime manifest seed signing argument: ${field}`)
    }
  }
  return options
}

async function main() {
  const options = parseSshRelayRuntimeManifestSeedSigningArguments(process.argv.slice(2))
  const requestArtifact = await readSshRelayRuntimeManifestSigningRequestArtifact(
    options.requestPath
  )
  const result = await writeSshRelayRuntimeManifestSigningResult({
    requestArtifact,
    seedBase64: process.env.SSH_RELAY_RUNTIME_MANIFEST_SEED,
    outputDirectory: options.outputDirectory
  })
  process.stdout.write(`${JSON.stringify({ keyId: result.keyId })}\n`)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `SSH relay runtime manifest seed signing failed: ${error.stack ?? error}\n`
    )
    process.exitCode = 1
  })
}

export const SSH_RELAY_RUNTIME_MANIFEST_SEED_SIGNING_LIMITS = Object.freeze({
  maximumRequestArtifactBytes: MAX_REQUEST_ARTIFACT_BYTES
})
