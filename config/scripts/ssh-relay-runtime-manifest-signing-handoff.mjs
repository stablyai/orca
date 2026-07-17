import { createHash } from 'node:crypto'

import nacl from 'tweetnacl'

import {
  parseCanonicalSshRelayRuntimeManifestBytes,
  SSH_RELAY_RUNTIME_MAX_CANONICAL_MANIFEST_BYTES
} from './ssh-relay-runtime-manifest-assembly.mjs'

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u
const SIGNATURE_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u
const MAX_SIGNATURES = 4

export const SSH_RELAY_RUNTIME_MANIFEST_SIGNING_LIMITS = Object.freeze({
  maximumCanonicalBytes: SSH_RELAY_RUNTIME_MAX_CANONICAL_MANIFEST_BYTES
})

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`SSH relay runtime manifest signing ${label} must be an object`)
  }
}

function assertExactFields(value, fields, label) {
  assertObject(value, label)
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`SSH relay runtime manifest signing ${label} has unexpected or missing fields`)
  }
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function canonicalSignatureBytes(value) {
  if (typeof value !== 'string' || !SIGNATURE_PATTERN.test(value)) {
    throw new Error('SSH relay runtime manifest returned signature is not canonical base64')
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length !== nacl.sign.signatureLength || bytes.toString('base64') !== value) {
    throw new Error('SSH relay runtime manifest returned signature must contain exactly 64 bytes')
  }
  return bytes
}

function validateRequest(request) {
  assertExactFields(
    request,
    ['algorithm', 'canonicalBytes', 'payloadSha256', 'payloadSize'],
    'request'
  )
  if (request.algorithm !== 'ed25519-v1') {
    throw new Error('SSH relay runtime manifest signing request algorithm is unsupported')
  }
  if (!Buffer.isBuffer(request.canonicalBytes) && !(request.canonicalBytes instanceof Uint8Array)) {
    throw new Error('SSH relay runtime manifest signing request payload must be bytes')
  }
  const canonicalBytes = Buffer.from(request.canonicalBytes)
  if (
    !Number.isSafeInteger(request.payloadSize) ||
    request.payloadSize <= 0 ||
    request.payloadSize > SSH_RELAY_RUNTIME_MANIFEST_SIGNING_LIMITS.maximumCanonicalBytes ||
    request.payloadSize !== canonicalBytes.length
  ) {
    throw new Error('SSH relay runtime manifest signing request payload size is inconsistent')
  }
  if (
    !DIGEST_PATTERN.test(request.payloadSha256) ||
    request.payloadSha256 !== sha256(canonicalBytes)
  ) {
    throw new Error('SSH relay runtime manifest signing request payload SHA-256 is inconsistent')
  }
  const manifest = parseCanonicalSshRelayRuntimeManifestBytes(canonicalBytes)
  return { canonicalBytes, manifest }
}

export function sshRelayRuntimeManifestKeyId(publicKey) {
  if (!(publicKey instanceof Uint8Array) || publicKey.byteLength !== nacl.sign.publicKeyLength) {
    throw new Error('SSH relay runtime manifest Ed25519 public key must contain exactly 32 bytes')
  }
  return sha256(publicKey)
}

export function createSshRelayRuntimeManifestSigningRequest(input) {
  if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) {
    throw new Error('SSH relay runtime manifest signing payload must be bytes')
  }
  const canonicalBytes = Buffer.from(input)
  if (
    canonicalBytes.length === 0 ||
    canonicalBytes.length > SSH_RELAY_RUNTIME_MANIFEST_SIGNING_LIMITS.maximumCanonicalBytes
  ) {
    throw new Error('SSH relay runtime manifest signing payload exceeds its size limit')
  }
  parseCanonicalSshRelayRuntimeManifestBytes(canonicalBytes)
  return {
    algorithm: 'ed25519-v1',
    canonicalBytes,
    payloadSha256: sha256(canonicalBytes),
    payloadSize: canonicalBytes.length
  }
}

function acceptedKeyMap(input) {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_SIGNATURES) {
    throw new Error(
      'SSH relay runtime manifest signing accepted keys must be a bounded non-empty array'
    )
  }
  const keys = new Map()
  for (const [index, key] of input.entries()) {
    assertExactFields(key, ['keyId', 'publicKey'], `accepted key ${index}`)
    const derivedKeyId = sshRelayRuntimeManifestKeyId(key.publicKey)
    if (key.keyId !== derivedKeyId) {
      throw new Error('SSH relay runtime manifest signing accepted key ID disagrees with its bytes')
    }
    if (keys.has(key.keyId)) {
      throw new Error(
        `SSH relay runtime manifest signing has a duplicate accepted key: ${key.keyId}`
      )
    }
    keys.set(key.keyId, key.publicKey)
  }
  return keys
}

function verifySigningResults(results, keys, canonicalBytes) {
  if (!Array.isArray(results) || results.length === 0 || results.length > MAX_SIGNATURES) {
    throw new Error('SSH relay runtime manifest signing results must be a bounded non-empty array')
  }
  const seen = new Set()
  return results.map((result, index) => {
    // Why: the protected signer may return only the authenticated key identity and signature bytes.
    assertExactFields(result, ['keyId', 'signature'], `result ${index}`)
    if (!DIGEST_PATTERN.test(result.keyId)) {
      throw new Error('SSH relay runtime manifest signing result key ID is malformed')
    }
    if (seen.has(result.keyId)) {
      throw new Error(
        `SSH relay runtime manifest signing has a duplicate result key: ${result.keyId}`
      )
    }
    seen.add(result.keyId)
    const publicKey = keys.get(result.keyId)
    if (!publicKey) {
      throw new Error(`SSH relay runtime manifest signing returned an unknown key: ${result.keyId}`)
    }
    const signature = canonicalSignatureBytes(result.signature)
    if (!nacl.sign.detached.verify(canonicalBytes, signature, publicKey)) {
      throw new Error(
        `SSH relay runtime manifest signing returned an invalid signature: ${result.keyId}`
      )
    }
    return { algorithm: 'ed25519-v1', keyId: result.keyId, signature: result.signature }
  })
}

export function finalizeSshRelayRuntimeManifestSigningHandoff({
  request,
  signingResults,
  acceptedKeys
}) {
  const { canonicalBytes, manifest: unsignedManifest } = validateRequest(request)
  const keys = acceptedKeyMap(acceptedKeys)
  const signatures = verifySigningResults(signingResults, keys, canonicalBytes).sort(
    (left, right) => (left.keyId < right.keyId ? -1 : left.keyId > right.keyId ? 1 : 0)
  )
  const manifest = { ...unsignedManifest, signatures }
  const bytes = Buffer.from(JSON.stringify(manifest), 'utf8')
  return { manifest, bytes, sha256: sha256(bytes) }
}
