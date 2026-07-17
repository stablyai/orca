import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { createSshRelayArtifactTestManifest } from '../../src/main/ssh/ssh-relay-artifact-test-manifest.ts'
import { canonicalUnsignedSshRelayManifestBytes } from '../../src/main/ssh/ssh-relay-manifest-signature.ts'
import {
  assembleCanonicalSshRelayRuntimeManifest,
  parseCanonicalSshRelayRuntimeManifestBytes
} from './ssh-relay-runtime-manifest-assembly.mjs'
import { sshRelayRuntimeCompatibility } from './ssh-relay-runtime-compatibility.mjs'
import { computeSshRelayRuntimeContentId } from './ssh-relay-runtime-identity.mjs'

function unsignedManifest() {
  const { signatures: _signatures, ...unsigned } = createSshRelayArtifactTestManifest()
  return unsigned
}

function arm64TupleFrom(source) {
  const tuple = structuredClone(source)
  tuple.tupleId = 'linux-arm64-glibc'
  tuple.architecture = 'arm64'
  tuple.compatibility = structuredClone(sshRelayRuntimeCompatibility[tuple.tupleId])
  for (const entry of tuple.entries) {
    entry.path = entry.path.replaceAll('watcher-linux-x64-glibc', 'watcher-linux-arm64-glibc')
  }
  for (const file of tuple.nativeVerification.files) {
    file.path = file.path.replaceAll('watcher-linux-x64-glibc', 'watcher-linux-arm64-glibc')
  }
  tuple.metadataAssets.sbom.name = 'orca-ssh-relay-runtime-linux-arm64-glibc.spdx.json'
  tuple.metadataAssets.provenance.name = 'orca-ssh-relay-runtime-linux-arm64-glibc.provenance.json'
  tuple.contentId = computeSshRelayRuntimeContentId(tuple)
  tuple.archive.name = `orca-ssh-relay-runtime-v1-${tuple.tupleId}-${tuple.contentId.slice('sha256:'.length)}.tar.br`
  return tuple
}

describe('SSH relay runtime canonical manifest assembly', () => {
  it('matches the desktop canonical unsigned test vector exactly', () => {
    const assembled = assembleCanonicalSshRelayRuntimeManifest(unsignedManifest())

    expect(assembled.canonicalBytes.at(-1)).not.toBe('\n'.charCodeAt(0))
    expect(createHash('sha256').update(assembled.canonicalBytes).digest('hex')).toBe(
      'dc36bff51330eb3aa4791bf30c25eeedd6e8d4cbc57470d50f377c24e0a5ed06'
    )
    expect(assembled.sha256).toBe(
      'sha256:dc36bff51330eb3aa4791bf30c25eeedd6e8d4cbc57470d50f377c24e0a5ed06'
    )
    expect(parseCanonicalSshRelayRuntimeManifestBytes(assembled.canonicalBytes)).toEqual(
      assembled.manifest
    )
  })

  it('sorts tuples, entries, and native attestations by portable ASCII identity', () => {
    const input = unsignedManifest()
    const arm64 = arm64TupleFrom(input.tuples[0])
    input.tuples = [input.tuples[0], arm64].toReversed()
    for (const tuple of input.tuples) {
      tuple.entries = tuple.entries.toReversed()
      tuple.nativeVerification.files = tuple.nativeVerification.files.toReversed()
    }

    const first = assembleCanonicalSshRelayRuntimeManifest(input)
    input.tuples = input.tuples.toReversed()
    for (const tuple of input.tuples) {
      tuple.entries = tuple.entries.toReversed()
      tuple.nativeVerification.files = tuple.nativeVerification.files.toReversed()
    }
    const second = assembleCanonicalSshRelayRuntimeManifest(input)

    expect(first.canonicalBytes).toEqual(second.canonicalBytes)
    expect(second.canonicalBytes).toEqual(canonicalUnsignedSshRelayManifestBytes(input))
    expect(first.manifest.tuples.map((tuple) => tuple.tupleId)).toEqual([
      'linux-arm64-glibc',
      'linux-x64-glibc'
    ])
    for (const tuple of first.manifest.tuples) {
      expect(tuple.entries.map((entry) => entry.path)).toEqual(
        tuple.entries.map((entry) => entry.path).toSorted()
      )
      expect(tuple.nativeVerification.files.map((entry) => entry.path)).toEqual(
        tuple.nativeVerification.files.map((entry) => entry.path).toSorted()
      )
    }
  })

  it('rejects signatures, unknown fields, and non-canonical byte encodings', () => {
    expect(() =>
      assembleCanonicalSshRelayRuntimeManifest(createSshRelayArtifactTestManifest())
    ).toThrow(/unsigned|signature|field/i)

    const extra = unsignedManifest()
    extra.latest = true
    expect(() => assembleCanonicalSshRelayRuntimeManifest(extra)).toThrow(/unrecognized|field/i)

    const canonical = assembleCanonicalSshRelayRuntimeManifest(unsignedManifest()).canonicalBytes
    expect(() =>
      parseCanonicalSshRelayRuntimeManifestBytes(Buffer.concat([canonical, Buffer.from('\n')]))
    ).toThrow(/canonical/i)
    expect(() => parseCanonicalSshRelayRuntimeManifestBytes(Buffer.from([0xff]))).toThrow(/utf-?8/i)
  })

  it('fails closed on inconsistent identity, archive, metadata, and native trust content', () => {
    const mutations = [
      (manifest) => {
        manifest.tuples[0].contentId = `sha256:${'f'.repeat(64)}`
      },
      (manifest) => {
        manifest.tuples[0].archive.fileCount += 1
      },
      (manifest) => {
        manifest.tuples[0].metadataAssets.sbom.name = 'latest.json'
      },
      (manifest) => {
        manifest.tuples[0].nativeVerification.files[0].sha256 = `sha256:${'f'.repeat(64)}`
      }
    ]
    for (const mutate of mutations) {
      const manifest = unsignedManifest()
      mutate(manifest)
      expect(() => assembleCanonicalSshRelayRuntimeManifest(manifest)).toThrow()
    }
  })

  it('rejects duplicate tuples and invalid release/timestamp identities', () => {
    const duplicate = unsignedManifest()
    duplicate.tuples.push(structuredClone(duplicate.tuples[0]))
    expect(() => assembleCanonicalSshRelayRuntimeManifest(duplicate)).toThrow(/duplicate tuple/i)

    const channel = unsignedManifest()
    channel.build.channel = 'stable'
    expect(() => assembleCanonicalSshRelayRuntimeManifest(channel)).toThrow(/release|build/i)

    const timestamp = unsignedManifest()
    timestamp.createdAt = '2026-07-14T00:00:00Z'
    expect(() => assembleCanonicalSshRelayRuntimeManifest(timestamp)).toThrow(/timestamp/i)
  })
})
