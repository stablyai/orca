import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import nacl from 'tweetnacl'
import { afterEach, describe, expect, it } from 'vitest'

import { createSshRelayArtifactTestManifest } from '../../src/main/ssh/ssh-relay-artifact-test-manifest.ts'
import { verifySshRelayArtifactManifest } from '../../src/main/ssh/ssh-relay-manifest-signature.ts'
import { sshRelayRuntimeCompatibility } from './ssh-relay-runtime-compatibility.mjs'
import { computeSshRelayRuntimeContentId } from './ssh-relay-runtime-identity.mjs'
import {
  SSH_RELAY_RUNTIME_MANIFEST_AGGREGATE_LIMITS,
  finalizeSshRelayRuntimeManifestAggregate,
  prepareSshRelayRuntimeManifestAggregate
} from './ssh-relay-runtime-manifest-aggregate.mjs'
import { sshRelayRuntimeManifestKeyId } from './ssh-relay-runtime-manifest-signing-handoff.mjs'

const temporaryDirectories = []
const keyPair = nacl.sign.keyPair.fromSeed(Uint8Array.from({ length: 32 }, (_, index) => index))

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function fileReference(name, bytes) {
  return { name, size: bytes.length, sha256: sha256(bytes) }
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

async function writeTupleInput(inputDirectory, sourceTuple, suffix = '') {
  const tuple = structuredClone(sourceTuple)
  const archiveBytes = Buffer.from(`verified runtime archive ${tuple.tupleId}${suffix}`)
  const sbomBytes = Buffer.from(`{"spdxVersion":"SPDX-2.3","tuple":"${tuple.tupleId}"}\n`)
  const provenanceBytes = Buffer.from(
    `{"_type":"https://in-toto.io/Statement/v1","tuple":"${tuple.tupleId}"}\n`
  )
  tuple.archive.size = archiveBytes.length
  tuple.archive.sha256 = sha256(archiveBytes)
  tuple.metadataAssets.sbom = fileReference(tuple.metadataAssets.sbom.name, sbomBytes)
  tuple.metadataAssets.provenance = fileReference(
    tuple.metadataAssets.provenance.name,
    provenanceBytes
  )
  const descriptorName = `orca-ssh-relay-runtime-${tuple.tupleId}.manifest-tuple.json`
  const descriptorBytes = Buffer.from(
    `${JSON.stringify({ schemaVersion: 1, tuple }, null, 2)}\n`,
    'utf8'
  )
  const input = {
    tupleId: tuple.tupleId,
    descriptor: fileReference(descriptorName, descriptorBytes),
    archive: fileReference(tuple.archive.name, archiveBytes),
    sbom: { ...tuple.metadataAssets.sbom },
    provenance: { ...tuple.metadataAssets.provenance }
  }
  await Promise.all([
    writeFile(join(inputDirectory, input.descriptor.name), descriptorBytes),
    writeFile(join(inputDirectory, input.archive.name), archiveBytes),
    writeFile(join(inputDirectory, input.sbom.name), sbomBytes),
    writeFile(join(inputDirectory, input.provenance.name), provenanceBytes)
  ])
  return { input, tuple }
}

async function fixture({ includeArm64 = false } = {}) {
  const inputDirectory = await mkdtemp(join(tmpdir(), 'orca-runtime-manifest-aggregate-'))
  temporaryDirectories.push(inputDirectory)
  const manifest = createSshRelayArtifactTestManifest()
  const tuples = [manifest.tuples[0]]
  if (includeArm64) {
    tuples.push(arm64TupleFrom(manifest.tuples[0]))
  }
  const written = []
  for (const tuple of tuples) {
    written.push(await writeTupleInput(inputDirectory, tuple))
  }
  return {
    inputDirectory,
    build: structuredClone(manifest.build),
    createdAt: manifest.createdAt,
    tupleInputs: written.map((entry) => entry.input),
    tuples: written.map((entry) => entry.tuple)
  }
}

function acceptedKey() {
  return {
    keyId: sshRelayRuntimeManifestKeyId(keyPair.publicKey),
    publicKey: keyPair.publicKey
  }
}

function signingResult(request) {
  return {
    keyId: sshRelayRuntimeManifestKeyId(keyPair.publicKey),
    signature: Buffer.from(nacl.sign.detached(request.canonicalBytes, keyPair.secretKey)).toString(
      'base64'
    )
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('SSH relay runtime fail-closed manifest aggregate', () => {
  it('prepares exact verified tuple files and finalizes only verified signed bytes', async () => {
    const input = await fixture()
    const prepared = await prepareSshRelayRuntimeManifestAggregate(input)

    expect(prepared.inputTuples).toEqual(input.tupleInputs)
    expect(prepared.unsignedManifest.tuples).toHaveLength(1)
    expect(prepared.unsignedManifest.tuples[0]).toMatchObject({
      tupleId: input.tuples[0].tupleId,
      contentId: input.tuples[0].contentId,
      archive: input.tuples[0].archive,
      metadataAssets: input.tuples[0].metadataAssets
    })
    expect(prepared.unsignedManifest.tuples[0].nativeVerification.files).toEqual(
      input.tuples[0].nativeVerification.files.toSorted((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0
      )
    )
    expect(prepared.signingRequest.canonicalBytes).toEqual(
      Buffer.from(JSON.stringify(prepared.unsignedManifest), 'utf8')
    )
    const result = finalizeSshRelayRuntimeManifestAggregate({
      prepared,
      signingResults: [signingResult(prepared.signingRequest)],
      acceptedKeys: [acceptedKey()]
    })

    expect(Object.keys(result).sort()).toEqual([
      'bytes',
      'inputTuples',
      'inputTuplesSha256',
      'manifest',
      'manifestAsset',
      'sha256'
    ])
    expect(result.manifestAsset).toEqual({
      name: 'orca-ssh-relay-runtime-manifest.json',
      size: result.bytes.length,
      sha256: result.sha256
    })
    expect(result.inputTuplesSha256).toBe(prepared.inputTuplesSha256)
    expect(JSON.parse(result.bytes.toString('utf8'))).toEqual(result.manifest)
    expect(verifySshRelayArtifactManifest(result.manifest, [acceptedKey()])).toEqual(
      result.manifest
    )
  })

  it('fails closed on missing, extra, or mutated aggregate files', async () => {
    const missing = await fixture()
    await rm(join(missing.inputDirectory, missing.tupleInputs[0].provenance.name))
    await expect(prepareSshRelayRuntimeManifestAggregate(missing)).rejects.toThrow(
      /missing|unexpected/i
    )

    const extra = await fixture()
    await writeFile(join(extra.inputDirectory, 'unexpected.bin'), 'extra')
    await expect(prepareSshRelayRuntimeManifestAggregate(extra)).rejects.toThrow(
      /missing|unexpected/i
    )

    for (const field of ['archive', 'sbom', 'provenance', 'descriptor']) {
      const mutated = await fixture()
      await writeFile(join(mutated.inputDirectory, mutated.tupleInputs[0][field].name), 'mutated')
      await expect(prepareSshRelayRuntimeManifestAggregate(mutated)).rejects.toThrow(
        /size|sha-?256/i
      )
    }
  })

  it('rejects descriptor, tuple, and declared asset drift', async () => {
    const tuple = await fixture()
    const tupleDescriptorPath = join(tuple.inputDirectory, tuple.tupleInputs[0].descriptor.name)
    const tupleDocument = JSON.parse(await readFile(tupleDescriptorPath, 'utf8'))
    tupleDocument.tuple.tupleId = 'linux-arm64-glibc'
    const tupleBytes = Buffer.from(`${JSON.stringify(tupleDocument)}\n`)
    await writeFile(tupleDescriptorPath, tupleBytes)
    tuple.tupleInputs[0].descriptor = fileReference(
      tuple.tupleInputs[0].descriptor.name,
      tupleBytes
    )
    await expect(prepareSshRelayRuntimeManifestAggregate(tuple)).rejects.toThrow(
      /descriptor|tuple/i
    )

    const asset = await fixture()
    asset.tupleInputs[0].sbom.sha256 = `sha256:${'f'.repeat(64)}`
    await expect(prepareSshRelayRuntimeManifestAggregate(asset)).rejects.toThrow(/sha-?256/i)

    const descriptor = await fixture()
    const descriptorPath = join(
      descriptor.inputDirectory,
      descriptor.tupleInputs[0].descriptor.name
    )
    const document = JSON.parse(await readFile(descriptorPath, 'utf8'))
    document.latest = true
    const bytes = Buffer.from(`${JSON.stringify(document)}\n`)
    await writeFile(descriptorPath, bytes)
    descriptor.tupleInputs[0].descriptor = fileReference(
      descriptor.tupleInputs[0].descriptor.name,
      bytes
    )
    await expect(prepareSshRelayRuntimeManifestAggregate(descriptor)).rejects.toThrow(
      /descriptor.*field/i
    )
  })

  it('sorts tuple inputs and produces deterministic canonical requests', async () => {
    const input = await fixture({ includeArm64: true })
    input.tupleInputs.reverse()
    const first = await prepareSshRelayRuntimeManifestAggregate(input)
    input.tupleInputs.reverse()
    const second = await prepareSshRelayRuntimeManifestAggregate(input)

    expect(first.inputTuples.map((entry) => entry.tupleId)).toEqual([
      'linux-arm64-glibc',
      'linux-x64-glibc'
    ])
    expect(first.signingRequest.canonicalBytes).toEqual(second.signingRequest.canonicalBytes)
    expect(first.signingRequest.payloadSha256).toBe(second.signingRequest.payloadSha256)
  })

  it('rejects prepared-request and returned-signature drift', async () => {
    const input = await fixture()
    const prepared = await prepareSshRelayRuntimeManifestAggregate(input)
    const result = signingResult(prepared.signingRequest)
    prepared.signingRequest = {
      ...prepared.signingRequest,
      payloadSha256: `sha256:${'f'.repeat(64)}`
    }
    expect(() =>
      finalizeSshRelayRuntimeManifestAggregate({
        prepared,
        signingResults: [result],
        acceptedKeys: [acceptedKey()]
      })
    ).toThrow(/request|sha-?256/i)

    const receiptDrift = await prepareSshRelayRuntimeManifestAggregate(input)
    receiptDrift.inputTuples[0].descriptor.sha256 = `sha256:${'e'.repeat(64)}`
    expect(() =>
      finalizeSshRelayRuntimeManifestAggregate({
        prepared: receiptDrift,
        signingResults: [signingResult(receiptDrift.signingRequest)],
        acceptedKeys: [acceptedKey()]
      })
    ).toThrow(/receipt.*drift/i)

    const fresh = await prepareSshRelayRuntimeManifestAggregate(input)
    const invalid = signingResult(fresh.signingRequest)
    invalid.signature = Buffer.alloc(64).toString('base64')
    expect(() =>
      finalizeSshRelayRuntimeManifestAggregate({
        prepared: fresh,
        signingResults: [invalid],
        acceptedKeys: [acceptedKey()]
      })
    ).toThrow(/signature/i)
  })

  it('honors cancellation and tuple/metadata bounds', async () => {
    expect(SSH_RELAY_RUNTIME_MANIFEST_AGGREGATE_LIMITS).toEqual({
      maximumTuples: 8,
      maximumMetadataBytes: 32 * 1024 * 1024,
      timeoutMs: 15 * 60_000
    })
    const cancelled = await fixture()
    const controller = new AbortController()
    controller.abort(new Error('cancel manifest aggregate'))
    await expect(
      prepareSshRelayRuntimeManifestAggregate({ ...cancelled, signal: controller.signal })
    ).rejects.toThrow(/cancel manifest aggregate/i)

    const oversized = await fixture()
    oversized.tupleInputs[0].descriptor.size =
      SSH_RELAY_RUNTIME_MANIFEST_AGGREGATE_LIMITS.maximumMetadataBytes + 1
    await expect(prepareSshRelayRuntimeManifestAggregate(oversized)).rejects.toThrow(/size|limit/i)

    const overTupleLimit = await fixture()
    overTupleLimit.tupleInputs = Array.from(
      { length: SSH_RELAY_RUNTIME_MANIFEST_AGGREGATE_LIMITS.maximumTuples + 1 },
      () => structuredClone(overTupleLimit.tupleInputs[0])
    )
    await expect(prepareSshRelayRuntimeManifestAggregate(overTupleLimit)).rejects.toThrow(
      /bounded|tuple/i
    )
  })
})
