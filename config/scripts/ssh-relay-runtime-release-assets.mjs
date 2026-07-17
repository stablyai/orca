import { parseSshRelayRuntimeUnsignedManifest } from './ssh-relay-runtime-manifest-validation.mjs'

const ASSET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/u
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u
const SIGNATURE_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u
const MANAGED_ASSET_PREFIX = 'orca-ssh-relay-runtime-'
const MANIFEST_NAME = 'orca-ssh-relay-runtime-manifest.json'
const SIGNATURE_NAME = 'orca-ssh-relay-runtime-manifest.sig'
const MAX_ASSET_BYTES = 100 * 1024 * 1024
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_SIGNATURE_BYTES = 4096
const MAX_MANAGED_ASSETS = 26
const MAX_RELEASE_ASSETS = 1000
const MAX_SIGNATURES = 4

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`SSH relay runtime release assets ${label} must be an object`)
  }
}

function assertExactFields(value, fields, label) {
  assertObject(value, label)
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`SSH relay runtime release assets ${label} has unexpected or missing fields`)
  }
}

function parseReleaseTag(tag) {
  if (typeof tag !== 'string') {
    throw new Error('SSH relay runtime release assets tag is invalid')
  }
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
  throw new Error('SSH relay runtime release assets tag is invalid')
}

function normalizeSignatures(signatures) {
  if (!Array.isArray(signatures) || signatures.length === 0 || signatures.length > MAX_SIGNATURES) {
    throw new Error('SSH relay runtime release assets verified manifest signatures are invalid')
  }
  const keyIds = new Set()
  for (const [index, signature] of signatures.entries()) {
    assertExactFields(signature, ['algorithm', 'keyId', 'signature'], `manifest signature ${index}`)
    if (signature.algorithm !== 'ed25519-v1' || !DIGEST_PATTERN.test(signature.keyId)) {
      throw new Error('SSH relay runtime release assets verified manifest signature is invalid')
    }
    if (typeof signature.signature !== 'string' || !SIGNATURE_PATTERN.test(signature.signature)) {
      throw new Error('SSH relay runtime release assets verified manifest signature is invalid')
    }
    const signatureBytes = Buffer.from(signature.signature, 'base64')
    if (
      signatureBytes.length !== 64 ||
      signatureBytes.toString('base64') !== signature.signature ||
      keyIds.has(signature.keyId)
    ) {
      throw new Error('SSH relay runtime release assets verified manifest signature is invalid')
    }
    keyIds.add(signature.keyId)
  }
  return [...keyIds].sort()
}

function normalizeAssetDescriptor(asset, expectedName, label, maximum = MAX_ASSET_BYTES) {
  assertExactFields(asset, ['name', 'sha256', 'size'], label)
  if (asset.name !== expectedName || !ASSET_NAME_PATTERN.test(asset.name)) {
    throw new Error(`SSH relay runtime release assets ${label} has an invalid name`)
  }
  if (!DIGEST_PATTERN.test(asset.sha256)) {
    throw new Error(`SSH relay runtime release assets ${label} has an invalid SHA-256`)
  }
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > maximum) {
    throw new Error(`SSH relay runtime release assets ${label} has an invalid size`)
  }
  return { ...asset }
}

function normalizeSignatureAsset(asset, manifestAsset, manifestKeyIds) {
  assertExactFields(
    asset,
    ['keyIds', 'manifestSha256', 'name', 'sha256', 'size'],
    'signature asset'
  )
  const descriptor = normalizeAssetDescriptor(
    { name: asset.name, sha256: asset.sha256, size: asset.size },
    SIGNATURE_NAME,
    'signature asset descriptor',
    MAX_SIGNATURE_BYTES
  )
  if (
    !Array.isArray(asset.keyIds) ||
    asset.keyIds.length === 0 ||
    asset.keyIds.length > MAX_SIGNATURES ||
    asset.keyIds.some((keyId) => typeof keyId !== 'string' || !DIGEST_PATTERN.test(keyId))
  ) {
    throw new Error('SSH relay runtime release assets signature keys are invalid')
  }
  if (!DIGEST_PATTERN.test(asset.manifestSha256)) {
    throw new Error('SSH relay runtime release assets signature manifest identity is invalid')
  }
  if (asset.manifestSha256 !== manifestAsset.sha256) {
    throw new Error(
      'SSH relay runtime release assets signature manifest identity disagrees with the manifest'
    )
  }
  const keyIds = [...new Set(asset.keyIds)].sort()
  if (
    keyIds.length !== asset.keyIds.length ||
    JSON.stringify(keyIds) !== JSON.stringify(manifestKeyIds)
  ) {
    // Why: the detached encoding stays separately gated, but it cannot claim different signers.
    throw new Error('SSH relay runtime release assets signature keys disagree with the manifest')
  }
  return descriptor
}

function normalizeVerifiedManifest(envelope) {
  assertExactFields(
    envelope,
    ['manifest', 'manifestAsset', 'signatureAsset'],
    'verified manifest envelope'
  )
  assertObject(envelope.manifest, 'verified manifest')
  const { signatures, ...unsignedManifest } = envelope.manifest
  const manifest = parseSshRelayRuntimeUnsignedManifest(unsignedManifest)
  const manifestKeyIds = normalizeSignatures(signatures)
  const manifestAsset = normalizeAssetDescriptor(
    envelope.manifestAsset,
    MANIFEST_NAME,
    'manifest asset',
    MAX_MANIFEST_BYTES
  )
  const signatureAsset = normalizeSignatureAsset(
    envelope.signatureAsset,
    manifestAsset,
    manifestKeyIds
  )
  return { manifest, manifestAsset, signatureAsset }
}

function coveredManifestAssets(manifest) {
  const assets = []
  for (const tuple of manifest.tuples) {
    assets.push(
      normalizeAssetDescriptor(
        {
          name: tuple.archive.name,
          sha256: tuple.archive.sha256,
          size: tuple.archive.size
        },
        tuple.archive.name,
        `${tuple.tupleId} archive`
      ),
      normalizeAssetDescriptor(
        tuple.metadataAssets.sbom,
        tuple.metadataAssets.sbom.name,
        `${tuple.tupleId} SBOM`
      ),
      normalizeAssetDescriptor(
        tuple.metadataAssets.provenance,
        tuple.metadataAssets.provenance.name,
        `${tuple.tupleId} provenance`
      )
    )
  }
  return assets
}

function exactManagedAssets(verified) {
  const assets = [
    ...coveredManifestAssets(verified.manifest),
    verified.manifestAsset,
    verified.signatureAsset
  ]
  if (assets.length === 0 || assets.length > MAX_MANAGED_ASSETS) {
    throw new Error('SSH relay runtime release assets coverage must be a bounded non-empty set')
  }
  const names = new Set()
  let totalBytes = 0
  for (const asset of assets) {
    if (!asset.name.startsWith(MANAGED_ASSET_PREFIX) || names.has(asset.name)) {
      throw new Error(
        `SSH relay runtime release assets has duplicate or invalid coverage: ${asset.name}`
      )
    }
    names.add(asset.name)
    totalBytes += asset.size
  }
  if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_BYTES) {
    throw new Error('SSH relay runtime release assets coverage exceeds the total size limit')
  }
  return assets
}

function validateBuildIdentity(manifest, expected) {
  if (manifest.build.tag !== expected.tag) {
    throw new Error('SSH relay runtime release assets manifest tag does not match the release')
  }
  if (manifest.build.channel !== expected.channel || manifest.build.version !== expected.version) {
    throw new Error('SSH relay runtime release assets manifest build identity does not match')
  }
}

function validateRelease(release, releaseId, expectedIdentity, expectedAssets) {
  assertObject(release, 'authenticated release metadata')
  if (!Number.isSafeInteger(releaseId) || releaseId <= 0 || release.id !== releaseId) {
    throw new Error('SSH relay runtime release assets release ID does not match')
  }
  if (release.draft !== true) {
    throw new Error('SSH relay runtime release assets requires an exact unpublished draft')
  }
  if (release.tag_name !== expectedIdentity.tag) {
    throw new Error('SSH relay runtime release assets release tag does not match')
  }
  const expectedPrerelease = expectedIdentity.channel !== 'stable'
  if (release.prerelease !== expectedPrerelease) {
    throw new Error('SSH relay runtime release assets prerelease state disagrees with its channel')
  }
  if (!Array.isArray(release.assets) || release.assets.length > MAX_RELEASE_ASSETS) {
    throw new Error('SSH relay runtime release assets metadata must contain a bounded asset array')
  }

  const expectedByName = new Map(expectedAssets.map((asset) => [asset.name, asset]))
  const releaseByName = new Map()
  for (const asset of release.assets) {
    assertObject(asset, 'release asset')
    if (typeof asset.name !== 'string' || !ASSET_NAME_PATTERN.test(asset.name)) {
      throw new Error('SSH relay runtime release assets has an invalid release asset')
    }
    if (releaseByName.has(asset.name)) {
      throw new Error(
        `SSH relay runtime release assets has a duplicate release asset: ${asset.name}`
      )
    }
    releaseByName.set(asset.name, asset)
    if (asset.name.startsWith(MANAGED_ASSET_PREFIX) && !expectedByName.has(asset.name)) {
      throw new Error(
        `SSH relay runtime release assets has an unexpected managed asset: ${asset.name}`
      )
    }
  }

  for (const expected of expectedAssets) {
    const actual = releaseByName.get(expected.name)
    if (!actual) {
      throw new Error(`SSH relay runtime release assets is missing managed asset: ${expected.name}`)
    }
    if (!Number.isSafeInteger(actual.id) || actual.id <= 0) {
      throw new Error(`SSH relay runtime release asset ID is invalid: ${expected.name}`)
    }
    if (actual.state !== 'uploaded') {
      throw new Error(`SSH relay runtime release asset is not uploaded: ${expected.name}`)
    }
    if (actual.size === 0) {
      throw new Error(`SSH relay runtime release asset is empty: ${expected.name}`)
    }
    if (actual.size !== expected.size) {
      throw new Error(`SSH relay runtime release asset size disagrees: ${expected.name}`)
    }
  }
}

export function verifySshRelayRuntimeReleaseAssets({ releaseId, tag, release, verifiedManifest }) {
  const expectedIdentity = parseReleaseTag(tag)
  const verified = normalizeVerifiedManifest(verifiedManifest)
  validateBuildIdentity(verified.manifest, expectedIdentity)
  const expectedAssets = exactManagedAssets(verified)
  // Why: this pure boundary can consume authenticated metadata without gaining release authority.
  validateRelease(release, releaseId, expectedIdentity, expectedAssets)
  return {
    releaseId: release.id,
    tag,
    channel: expectedIdentity.channel,
    draft: true,
    prerelease: release.prerelease,
    checked: expectedAssets.map((asset) => asset.name).sort()
  }
}
