import { createHash } from 'node:crypto'

import nacl from 'tweetnacl'
import { describe, expect, it } from 'vitest'

import { createSshRelayArtifactTestManifest } from './ssh-relay-artifact-test-manifest'
import {
  canonicalUnsignedSshRelayManifestBytes,
  signSshRelayArtifactManifest,
  sshRelayManifestKeyId,
  verifySshRelayArtifactManifest
} from './ssh-relay-manifest-signature'

const keyPair = nacl.sign.keyPair.fromSeed(Uint8Array.from({ length: 32 }, (_, index) => index))

function signedManifest() {
  const manifest = createSshRelayArtifactTestManifest()
  manifest.signatures = [signSshRelayArtifactManifest(manifest, keyPair.secretKey)]
  return manifest
}

function unsignedManifest() {
  const { signatures: _signatures, ...unsigned } = createSshRelayArtifactTestManifest()
  return unsigned
}

describe('SSH relay manifest signatures', () => {
  it('canonicalizes object keys independently of insertion order', () => {
    const manifest = createSshRelayArtifactTestManifest()
    const reordered = {
      signatures: manifest.signatures,
      tuples: manifest.tuples,
      createdAt: manifest.createdAt,
      build: manifest.build,
      schemaVersion: manifest.schemaVersion
    }

    expect(canonicalUnsignedSshRelayManifestBytes(reordered)).toEqual(
      canonicalUnsignedSshRelayManifestBytes(manifest)
    )
  })

  it('has a fixed canonical unsigned test vector and ignores array insertion order', () => {
    const manifest = createSshRelayArtifactTestManifest()
    const reordered = structuredClone(manifest)
    reordered.tuples[0].entries.reverse()
    reordered.tuples[0].nativeVerification.files.reverse()
    reordered.signatures[0].signature = Buffer.alloc(64, 1).toString('base64')

    const canonical = canonicalUnsignedSshRelayManifestBytes(manifest)
    expect(canonicalUnsignedSshRelayManifestBytes(reordered)).toEqual(canonical)
    expect(createHash('sha256').update(canonical).digest('hex')).toBe(
      'dc36bff51330eb3aa4791bf30c25eeedd6e8d4cbc57470d50f377c24e0a5ed06'
    )
  })

  it('creates the first signature from validated unsigned content', () => {
    const unsigned = unsignedManifest()
    const signature = signSshRelayArtifactManifest(unsigned, keyPair.secretKey)
    const manifest = { ...unsigned, signatures: [signature] }

    expect(
      verifySshRelayArtifactManifest(manifest, [
        { keyId: sshRelayManifestKeyId(keyPair.publicKey), publicKey: keyPair.publicKey }
      ])
    ).toEqual(manifest)
  })

  it('rejects invalid key sizes and inconsistent unsigned content before signing', () => {
    expect(() => sshRelayManifestKeyId(new Uint8Array(31))).toThrow(/32 bytes/i)
    expect(() => signSshRelayArtifactManifest(unsignedManifest(), new Uint8Array(63))).toThrow(
      /64 bytes/i
    )

    const inconsistent = unsignedManifest()
    inconsistent.tuples[0].contentId = `sha256:${'f'.repeat(64)}`
    expect(() => signSshRelayArtifactManifest(inconsistent, keyPair.secretKey)).toThrow(
      /content identity/i
    )
  })

  it('verifies a signed manifest with the embedded accepted key', () => {
    const manifest = signedManifest()

    const verified = verifySshRelayArtifactManifest(manifest, [
      { keyId: sshRelayManifestKeyId(keyPair.publicKey), publicKey: keyPair.publicKey }
    ])

    expect(verified.tuples[0].contentId).toBe(manifest.tuples[0].contentId)
  })

  it('makes verified manifest fields immutable after signature acceptance', () => {
    const verified = verifySshRelayArtifactManifest(signedManifest(), [
      { keyId: sshRelayManifestKeyId(keyPair.publicKey), publicKey: keyPair.publicKey }
    ])

    expect(() => {
      Object.defineProperty(verified.tuples[0].archive, 'name', { value: 'latest.tar.br' })
    }).toThrow(TypeError)
  })

  it('rejects signed content mutation', () => {
    const manifest = signedManifest()
    manifest.build.relayProtocolVersion += 1

    expect(() =>
      verifySshRelayArtifactManifest(manifest, [
        { keyId: sshRelayManifestKeyId(keyPair.publicKey), publicKey: keyPair.publicKey }
      ])
    ).toThrow(/signature/i)
  })

  it('fails closed for unknown, duplicate, malformed, or mismatched keys', () => {
    const manifest = signedManifest()
    expect(() => verifySshRelayArtifactManifest(manifest, [])).toThrow(/unknown signing key/i)

    const duplicate = signedManifest()
    duplicate.signatures.push(structuredClone(duplicate.signatures[0]))
    expect(() => verifySshRelayArtifactManifest(duplicate, [])).toThrow(/duplicate signature/i)

    const malformed = signedManifest()
    malformed.signatures[0].signature = Buffer.alloc(63).toString('base64')
    expect(() => verifySshRelayArtifactManifest(malformed, [])).toThrow(/64 bytes/i)

    const otherPair = nacl.sign.keyPair()
    const mismatch = signedManifest()
    expect(() =>
      verifySshRelayArtifactManifest(mismatch, [
        { keyId: mismatch.signatures[0].keyId, publicKey: otherPair.publicKey }
      ])
    ).toThrow(/public key id/i)
  })

  it('accepts dual signatures only when every signing key is accepted', () => {
    const manifest = signedManifest()
    const nextKeyPair = nacl.sign.keyPair.fromSeed(
      Uint8Array.from({ length: 32 }, (_, index) => 31 - index)
    )
    manifest.signatures.push(signSshRelayArtifactManifest(manifest, nextKeyPair.secretKey))

    expect(() =>
      verifySshRelayArtifactManifest(manifest, [
        { keyId: sshRelayManifestKeyId(keyPair.publicKey), publicKey: keyPair.publicKey }
      ])
    ).toThrow(/unknown signing key/i)
    expect(
      verifySshRelayArtifactManifest(manifest, [
        { keyId: sshRelayManifestKeyId(keyPair.publicKey), publicKey: keyPair.publicKey },
        { keyId: sshRelayManifestKeyId(nextKeyPair.publicKey), publicKey: nextKeyPair.publicKey }
      ])
    ).toEqual(manifest)
  })
})
