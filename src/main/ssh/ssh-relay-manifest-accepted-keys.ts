import { createHash } from 'node:crypto'

import {
  sshRelayManifestKeyId,
  type SshRelayManifestAcceptedKey
} from './ssh-relay-manifest-signature'
import type { SshRelayDigest } from './ssh-relay-runtime-identity'

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u
const MAXIMUM_KEYS = 4

type AcceptedKeyRecord = {
  keyId: string
  publicKeyBase64: string
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`SSH relay manifest ${label} must be an object`)
  }
}

function assertExactFields(value: Record<string, unknown>, fields: string[], label: string): void {
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    throw new Error(`SSH relay manifest ${label} has unexpected or missing fields`)
  }
}

function decodePublicKey(value: unknown): { bytes: Buffer; base64: string } {
  if (typeof value !== 'string' || !BASE64.test(value)) {
    throw new Error('SSH relay manifest accepted public key is not canonical base64')
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.byteLength !== 32 || bytes.toString('base64') !== value) {
    throw new Error('SSH relay manifest accepted public key must contain exactly 32 bytes')
  }
  return { bytes, base64: value }
}

function sha256(bytes: Uint8Array): SshRelayDigest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

export function parseSshRelayManifestAcceptedKeyDocument(input: unknown): Readonly<{
  acceptedKeys: readonly Readonly<SshRelayManifestAcceptedKey>[]
  sha256: SshRelayDigest
}> {
  assertObject(input, 'accepted-key document')
  assertExactFields(input, ['keys', 'schemaVersion'], 'accepted-key document')
  if (
    input.schemaVersion !== 1 ||
    !Array.isArray(input.keys) ||
    input.keys.length === 0 ||
    input.keys.length > MAXIMUM_KEYS
  ) {
    throw new Error('SSH relay manifest accepted keys must be a bounded schema-version-1 array')
  }

  const seen = new Set<string>()
  const parsed = input.keys
    .map((value, index) => {
      assertObject(value, `accepted key ${index}`)
      assertExactFields(value, ['keyId', 'publicKeyBase64'], `accepted key ${index}`)
      const decoded = decodePublicKey(value.publicKeyBase64)
      const publicKey = decoded.bytes
      const keyId = sshRelayManifestKeyId(publicKey)
      if (value.keyId !== keyId) {
        throw new Error('SSH relay manifest accepted key ID disagrees with its public key bytes')
      }
      if (seen.has(keyId)) {
        throw new Error(`Duplicate accepted SSH relay manifest key: ${keyId}`)
      }
      seen.add(keyId)
      return { keyId, publicKeyBase64: decoded.base64, publicKey }
    })
    .sort((left, right) => (left.keyId < right.keyId ? -1 : left.keyId > right.keyId ? 1 : 0))

  // Why: the protected aggregate fingerprints this exact sorted projection, so desktop build
  // evidence can prove it embedded the reviewed public-key set without trusting input order.
  const canonicalRecords: AcceptedKeyRecord[] = parsed.map(({ keyId, publicKeyBase64 }) => ({
    keyId,
    publicKeyBase64
  }))
  const canonicalBytes = Buffer.from(
    JSON.stringify({ schemaVersion: 1, keys: canonicalRecords }),
    'utf8'
  )
  const acceptedKeys = Object.freeze(
    parsed.map(({ keyId, publicKey }) => Object.freeze({ keyId, publicKey }))
  )
  return Object.freeze({ acceptedKeys, sha256: sha256(canonicalBytes) })
}

export const SSH_RELAY_MANIFEST_ACCEPTED_KEY_LIMITS = Object.freeze({ maximumKeys: MAXIMUM_KEYS })
