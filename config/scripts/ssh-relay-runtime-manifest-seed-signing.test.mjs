import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import nacl from 'tweetnacl'
import { afterEach, describe, expect, it } from 'vitest'

import { createSshRelayArtifactTestManifest } from '../../src/main/ssh/ssh-relay-artifact-test-manifest.ts'
import { assembleCanonicalSshRelayRuntimeManifest } from './ssh-relay-runtime-manifest-assembly.mjs'
import {
  createSshRelayRuntimeManifestSigningRequest,
  finalizeSshRelayRuntimeManifestSigningHandoff,
  sshRelayRuntimeManifestKeyId
} from './ssh-relay-runtime-manifest-signing-handoff.mjs'
import {
  decodeSshRelayRuntimeManifestSigningRequestArtifact,
  encodeSshRelayRuntimeManifestSigningRequestArtifact,
  signSshRelayRuntimeManifestRequest,
  writeSshRelayRuntimeManifestSigningResult
} from './ssh-relay-runtime-manifest-seed-signing.mjs'

const temporaryDirectories = []
const seed = Uint8Array.from({ length: 32 }, (_, index) => index)
const seedBase64 = Buffer.from(seed).toString('base64')
const keyPair = nacl.sign.keyPair.fromSeed(seed)

function request() {
  const { signatures: _signatures, ...unsigned } = createSshRelayArtifactTestManifest()
  const canonical = assembleCanonicalSshRelayRuntimeManifest(unsigned).canonicalBytes
  return createSshRelayRuntimeManifestSigningRequest(canonical)
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('SSH relay runtime protected manifest seed signing', () => {
  it('round-trips a bounded canonical request and returns only key ID plus signature', () => {
    const source = request()
    const artifact = encodeSshRelayRuntimeManifestSigningRequestArtifact(source)
    const decoded = decodeSshRelayRuntimeManifestSigningRequestArtifact(artifact)
    const result = signSshRelayRuntimeManifestRequest({ requestArtifact: artifact, seedBase64 })

    expect(decoded).toEqual(source)
    expect(Object.keys(artifact).sort()).toEqual([
      'algorithm',
      'payloadBase64',
      'payloadSha256',
      'payloadSize',
      'schemaVersion'
    ])
    expect(result).toEqual({
      keyId: sshRelayRuntimeManifestKeyId(keyPair.publicKey),
      signature: Buffer.from(nacl.sign.detached(source.canonicalBytes, keyPair.secretKey)).toString(
        'base64'
      )
    })
    expect(
      finalizeSshRelayRuntimeManifestSigningHandoff({
        request: decoded,
        signingResults: [result],
        acceptedKeys: [{ keyId: result.keyId, publicKey: keyPair.publicKey }]
      }).manifest.signatures
    ).toEqual([{ algorithm: 'ed25519-v1', ...result }])
  })

  it.each([
    ['', /seed/i],
    ['not-base64', /seed|base64/i],
    [`${seedBase64}\n`, /seed|base64/i],
    [Buffer.alloc(31).toString('base64'), /32 bytes|seed/i],
    [Buffer.alloc(33).toString('base64'), /32 bytes|seed/i]
  ])('rejects a malformed or non-canonical seed without a result', (candidate, message) => {
    expect(() =>
      signSshRelayRuntimeManifestRequest({
        requestArtifact: encodeSshRelayRuntimeManifestSigningRequestArtifact(request()),
        seedBase64: candidate
      })
    ).toThrow(message)
  })

  it('rejects request field, size, hash, canonical-byte, and base64 drift', () => {
    const valid = encodeSshRelayRuntimeManifestSigningRequestArtifact(request())
    const cases = [
      { ...valid, extra: true },
      { ...valid, algorithm: 'rsa-v1' },
      { ...valid, payloadSize: valid.payloadSize + 1 },
      { ...valid, payloadSha256: `sha256:${'f'.repeat(64)}` },
      { ...valid, payloadBase64: `${valid.payloadBase64}\n` },
      { ...valid, payloadBase64: Buffer.from('{}').toString('base64'), payloadSize: 2 }
    ]
    for (const artifact of cases) {
      expect(() =>
        signSshRelayRuntimeManifestRequest({ requestArtifact: artifact, seedBase64 })
      ).toThrow()
    }
  })

  it('writes only an exclusive bounded result and removes partial output on failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-runtime-manifest-seed-signing-'))
    temporaryDirectories.push(root)
    const outputDirectory = join(root, 'result')
    const result = await writeSshRelayRuntimeManifestSigningResult({
      requestArtifact: encodeSshRelayRuntimeManifestSigningRequestArtifact(request()),
      seedBase64,
      outputDirectory
    })
    expect(
      JSON.parse(await readFile(join(outputDirectory, 'signing-result.json'), 'utf8'))
    ).toEqual(result)
    await expect(
      writeSshRelayRuntimeManifestSigningResult({
        requestArtifact: encodeSshRelayRuntimeManifestSigningRequestArtifact(request()),
        seedBase64,
        outputDirectory
      })
    ).rejects.toThrow(/exclusive|absent/i)

    const failed = join(root, 'failed')
    await expect(
      writeSshRelayRuntimeManifestSigningResult({
        requestArtifact: { invalid: true },
        seedBase64,
        outputDirectory: failed
      })
    ).rejects.toThrow()
    await expect(readFile(join(failed, 'signing-result.json'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('rejects a symlinked request path before reading CLI input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-runtime-manifest-seed-signing-'))
    temporaryDirectories.push(root)
    const target = join(root, 'request.json')
    const linked = join(root, 'linked.json')
    await writeFile(
      target,
      JSON.stringify(encodeSshRelayRuntimeManifestSigningRequestArtifact(request()))
    )
    await expect(
      import('node:fs/promises').then(({ symlink }) => symlink(target, linked))
    ).resolves.toBeUndefined()
    const { readSshRelayRuntimeManifestSigningRequestArtifact } =
      await import('./ssh-relay-runtime-manifest-seed-signing.mjs')
    await expect(readSshRelayRuntimeManifestSigningRequestArtifact(linked)).rejects.toThrow(
      /regular file|symlink/i
    )
  })
})
