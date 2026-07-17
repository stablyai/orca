import nacl from 'tweetnacl'
import { describe, expect, it } from 'vitest'

import { createSshRelayArtifactTestManifest } from '../../src/main/ssh/ssh-relay-artifact-test-manifest.ts'
import { verifySshRelayArtifactManifest } from '../../src/main/ssh/ssh-relay-manifest-signature.ts'
import { assembleCanonicalSshRelayRuntimeManifest } from './ssh-relay-runtime-manifest-assembly.mjs'
import {
  SSH_RELAY_RUNTIME_MANIFEST_SIGNING_LIMITS,
  createSshRelayRuntimeManifestSigningRequest,
  finalizeSshRelayRuntimeManifestSigningHandoff,
  sshRelayRuntimeManifestKeyId
} from './ssh-relay-runtime-manifest-signing-handoff.mjs'

const keyPair = nacl.sign.keyPair.fromSeed(Uint8Array.from({ length: 32 }, (_, index) => index))
const nextKeyPair = nacl.sign.keyPair.fromSeed(
  Uint8Array.from({ length: 32 }, (_, index) => 31 - index)
)

function assembly() {
  const { signatures: _signatures, ...unsigned } = createSshRelayArtifactTestManifest()
  return assembleCanonicalSshRelayRuntimeManifest(unsigned)
}

function signingResult(request, pair = keyPair) {
  return {
    keyId: sshRelayRuntimeManifestKeyId(pair.publicKey),
    signature: Buffer.from(nacl.sign.detached(request.canonicalBytes, pair.secretKey)).toString(
      'base64'
    )
  }
}

function acceptedKey(pair = keyPair) {
  return { keyId: sshRelayRuntimeManifestKeyId(pair.publicKey), publicKey: pair.publicKey }
}

describe('SSH relay runtime manifest signing handoff', () => {
  it('creates a bounded request over the exact canonical unsigned bytes', () => {
    const canonical = assembly().canonicalBytes
    const request = createSshRelayRuntimeManifestSigningRequest(canonical)

    expect(SSH_RELAY_RUNTIME_MANIFEST_SIGNING_LIMITS).toEqual({
      maximumCanonicalBytes: 32 * 1024 * 1024
    })
    expect(Object.keys(request).sort()).toEqual([
      'algorithm',
      'canonicalBytes',
      'payloadSha256',
      'payloadSize'
    ])
    expect(request).toMatchObject({
      algorithm: 'ed25519-v1',
      payloadSha256: 'sha256:dc36bff51330eb3aa4791bf30c25eeedd6e8d4cbc57470d50f377c24e0a5ed06',
      payloadSize: canonical.length
    })
    expect(request.canonicalBytes).toEqual(canonical)
  })

  it('accepts only key ID plus a verified returned signature', () => {
    const request = createSshRelayRuntimeManifestSigningRequest(assembly().canonicalBytes)
    const result = signingResult(request)
    expect(Object.keys(result).sort()).toEqual(['keyId', 'signature'])

    const finalized = finalizeSshRelayRuntimeManifestSigningHandoff({
      request,
      signingResults: [result],
      acceptedKeys: [acceptedKey()]
    })

    expect(finalized.manifest.signatures).toEqual([{ algorithm: 'ed25519-v1', ...result }])
    expect(finalized.bytes.at(-1)).not.toBe('\n'.charCodeAt(0))
    expect(JSON.parse(finalized.bytes.toString('utf8'))).toEqual(finalized.manifest)
    expect(verifySshRelayArtifactManifest(finalized.manifest, [acceptedKey()])).toEqual(
      finalized.manifest
    )
  })

  it('reconstructs canonical content and rejects request drift', () => {
    const request = createSshRelayRuntimeManifestSigningRequest(assembly().canonicalBytes)
    const result = signingResult(request)

    for (const mutate of [
      (copy) => {
        copy.payloadSize += 1
      },
      (copy) => {
        copy.payloadSha256 = `sha256:${'f'.repeat(64)}`
      },
      (copy) => {
        copy.algorithm = 'rsa-v1'
      },
      (copy) => {
        copy.canonicalBytes = Buffer.concat([copy.canonicalBytes, Buffer.from('\n')])
      }
    ]) {
      const copy = { ...request, canonicalBytes: Buffer.from(request.canonicalBytes) }
      mutate(copy)
      expect(() =>
        finalizeSshRelayRuntimeManifestSigningHandoff({
          request: copy,
          signingResults: [result],
          acceptedKeys: [acceptedKey()]
        })
      ).toThrow()
    }
  })

  it('fails closed on malformed, unknown, duplicate, or invalid returned signatures', () => {
    const request = createSshRelayRuntimeManifestSigningRequest(assembly().canonicalBytes)
    const result = signingResult(request)
    const cases = [
      { signingResults: [], acceptedKeys: [acceptedKey()] },
      { signingResults: [{ ...result, extra: true }], acceptedKeys: [acceptedKey()] },
      {
        signingResults: [{ ...result, signature: Buffer.alloc(63).toString('base64') }],
        acceptedKeys: [acceptedKey()]
      },
      { signingResults: [result], acceptedKeys: [acceptedKey(nextKeyPair)] },
      {
        signingResults: [{ ...result, signature: Buffer.alloc(64).toString('base64') }],
        acceptedKeys: [acceptedKey()]
      },
      { signingResults: [result, structuredClone(result)], acceptedKeys: [acceptedKey()] }
    ]
    for (const testCase of cases) {
      expect(() =>
        finalizeSshRelayRuntimeManifestSigningHandoff({ request, ...testCase })
      ).toThrow()
    }
  })

  it('sorts verified dual signatures by key ID for deterministic final bytes', () => {
    const request = createSshRelayRuntimeManifestSigningRequest(assembly().canonicalBytes)
    const results = [
      signingResult(request, nextKeyPair),
      signingResult(request, keyPair)
    ].toReversed()
    const acceptedKeys = [acceptedKey(nextKeyPair), acceptedKey(keyPair)].toReversed()

    const first = finalizeSshRelayRuntimeManifestSigningHandoff({
      request,
      signingResults: results,
      acceptedKeys
    })
    const second = finalizeSshRelayRuntimeManifestSigningHandoff({
      request,
      signingResults: results.toReversed(),
      acceptedKeys: acceptedKeys.toReversed()
    })

    expect(first.bytes).toEqual(second.bytes)
    expect(first.manifest.signatures.map((entry) => entry.keyId)).toEqual(
      first.manifest.signatures.map((entry) => entry.keyId).toSorted()
    )
  })

  it('rejects empty, non-byte, and oversized signing payloads before handoff', () => {
    expect(() => createSshRelayRuntimeManifestSigningRequest(Buffer.alloc(0))).toThrow(
      /empty|size/i
    )
    expect(() => createSshRelayRuntimeManifestSigningRequest('{}')).toThrow(/bytes/i)
    expect(() =>
      createSshRelayRuntimeManifestSigningRequest(
        Buffer.alloc(SSH_RELAY_RUNTIME_MANIFEST_SIGNING_LIMITS.maximumCanonicalBytes + 1)
      )
    ).toThrow(/size|limit/i)
  })
})
