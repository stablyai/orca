import { describe, expect, it, vi } from 'vitest'

import { createSshRelayArtifactTestManifest } from '../../src/main/ssh/ssh-relay-artifact-test-manifest'
import { verifySshRelayRuntimeReleaseAssets } from './ssh-relay-runtime-release-assets.mjs'

const MANIFEST_NAME = 'orca-ssh-relay-runtime-manifest.json'
const SIGNATURE_NAME = 'orca-ssh-relay-runtime-manifest.sig'
const digest = (character) => `sha256:${character.repeat(64)}`

function buildIdentity(tag) {
  for (const [pattern, channel] of [
    [/^v(\d+\.\d+\.\d+)$/u, 'stable'],
    [/^v(\d+\.\d+\.\d+-rc\.\d+)$/u, 'rc'],
    [/^v(\d+\.\d+\.\d+-rc\.\d+\.perf)$/u, 'perf']
  ]) {
    const match = pattern.exec(tag)
    if (match) {
      return { tag, channel, version: match[1] }
    }
  }
  throw new Error(`Unsupported test tag: ${tag}`)
}

function fixture(tag = 'v1.4.140-rc.1') {
  const manifest = createSshRelayArtifactTestManifest()
  manifest.build = { ...manifest.build, ...buildIdentity(tag) }
  const manifestAsset = { name: MANIFEST_NAME, size: 2_048, sha256: digest('e') }
  const signatureAsset = {
    name: SIGNATURE_NAME,
    size: 256,
    sha256: digest('f'),
    manifestSha256: manifestAsset.sha256,
    keyIds: manifest.signatures.map((signature) => signature.keyId)
  }
  const expectedAssets = [
    manifest.tuples[0].archive,
    manifest.tuples[0].metadataAssets.sbom,
    manifest.tuples[0].metadataAssets.provenance,
    manifestAsset,
    signatureAsset
  ]
  const release = {
    id: 42,
    tag_name: tag,
    draft: true,
    prerelease: manifest.build.channel !== 'stable',
    assets: [
      ...expectedAssets.map((asset, index) => ({
        id: index + 1,
        name: asset.name,
        state: 'uploaded',
        size: asset.size
      })),
      { id: 99, name: 'orca-windows-setup.exe', state: 'uploaded', size: 3_000 }
    ]
  }
  return {
    releaseId: release.id,
    tag,
    release,
    verifiedManifest: { manifest, manifestAsset, signatureAsset }
  }
}

function managedAsset(input, name) {
  return input.release.assets.find((asset) => asset.name === name)
}

describe('SSH relay runtime release required assets', () => {
  it.each([
    ['v1.4.140', 'stable', false],
    ['v1.4.140-rc.2', 'rc', true],
    ['v1.4.140-rc.2.perf', 'perf', true]
  ])(
    'accepts exact %s manifest coverage and authenticated draft metadata',
    (tag, channel, prerelease) => {
      const input = fixture(tag)

      expect(verifySshRelayRuntimeReleaseAssets(input)).toEqual({
        releaseId: 42,
        tag,
        channel,
        draft: true,
        prerelease,
        checked: expect.arrayContaining([
          input.verifiedManifest.manifest.tuples[0].archive.name,
          input.verifiedManifest.manifest.tuples[0].metadataAssets.sbom.name,
          input.verifiedManifest.manifest.tuples[0].metadataAssets.provenance.name,
          MANIFEST_NAME,
          SIGNATURE_NAME
        ])
      })
    }
  )

  it.each([
    ['missing', (input) => input.release.assets.splice(0, 1), /missing managed asset/i],
    [
      'extra managed',
      (input) =>
        input.release.assets.push({
          id: 100,
          name: 'orca-ssh-relay-runtime-uncovered.zip',
          state: 'uploaded',
          size: 1
        }),
      /unexpected managed asset/i
    ],
    [
      'duplicate',
      (input) => input.release.assets.push(structuredClone(input.release.assets[0])),
      /duplicate release asset/i
    ]
  ])('rejects a %s managed asset set', (_label, mutate, message) => {
    const input = fixture()
    mutate(input)
    expect(() => verifySshRelayRuntimeReleaseAssets(input)).toThrow(message)
  })

  it.each([
    ['non-uploaded', (asset) => (asset.state = 'new'), /not uploaded/i],
    ['empty', (asset) => (asset.size = 0), /empty/i],
    ['wrong-size', (asset) => (asset.size += 1), /size disagrees/i]
  ])('rejects a %s covered asset', (_label, mutate, message) => {
    const input = fixture()
    mutate(managedAsset(input, MANIFEST_NAME))
    expect(() => verifySshRelayRuntimeReleaseAssets(input)).toThrow(message)
  })

  it('rejects release, manifest, or prerelease identity crossing tags and channels', () => {
    const crossRelease = fixture()
    crossRelease.release.tag_name = 'v1.4.140-rc.2'
    expect(() => verifySshRelayRuntimeReleaseAssets(crossRelease)).toThrow(/release tag/i)

    const crossDraft = fixture()
    crossDraft.release.id += 1
    expect(() => verifySshRelayRuntimeReleaseAssets(crossDraft)).toThrow(/release ID/i)

    const crossManifest = fixture()
    Object.assign(crossManifest.verifiedManifest.manifest.build, buildIdentity('v1.4.140-rc.2'))
    expect(() => verifySshRelayRuntimeReleaseAssets(crossManifest)).toThrow(/manifest tag/i)

    const crossChannel = fixture()
    crossChannel.verifiedManifest.manifest.build.channel = 'stable'
    expect(() => verifySshRelayRuntimeReleaseAssets(crossChannel)).toThrow(/manifest.*identity/i)

    const wrongPrerelease = fixture()
    wrongPrerelease.release.prerelease = false
    expect(() => verifySshRelayRuntimeReleaseAssets(wrongPrerelease)).toThrow(/prerelease/i)
  })

  it('rejects a detached signature asset that disagrees with verified manifest signatures', () => {
    const input = fixture()
    input.verifiedManifest.signatureAsset.keyIds = [digest('0')]

    expect(() => verifySshRelayRuntimeReleaseAssets(input)).toThrow(/signature keys disagree/i)

    const crossManifest = fixture()
    crossManifest.verifiedManifest.signatureAsset.manifestSha256 = digest('0')
    expect(() => verifySshRelayRuntimeReleaseAssets(crossManifest)).toThrow(
      /signature manifest identity disagrees/i
    )
  })

  it('rejects malformed or incomplete verified-manifest asset bindings', () => {
    const malformedDigest = fixture()
    malformedDigest.verifiedManifest.manifestAsset.sha256 = digest('A')
    expect(() => verifySshRelayRuntimeReleaseAssets(malformedDigest)).toThrow(/sha-256/i)

    const missingSignature = fixture()
    missingSignature.verifiedManifest.manifest.signatures = []
    expect(() => verifySshRelayRuntimeReleaseAssets(missingSignature)).toThrow(/signature/i)

    const malformedSignature = fixture()
    malformedSignature.verifiedManifest.manifest.signatures[0].signature = 42
    expect(() => verifySshRelayRuntimeReleaseAssets(malformedSignature)).toThrow(/signature/i)

    const unexpectedField = fixture()
    unexpectedField.verifiedManifest.manifestAsset.path = '/tmp/manifest'
    expect(() => verifySshRelayRuntimeReleaseAssets(unexpectedField)).toThrow(/fields/i)
  })

  it('is a disconnected metadata gate with no network request', () => {
    const fetchMock = vi.fn(() => {
      throw new Error('network must remain disconnected')
    })
    vi.stubGlobal('fetch', fetchMock)

    expect(() => verifySshRelayRuntimeReleaseAssets(fixture())).not.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
