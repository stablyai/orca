import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import nacl from 'tweetnacl'
import { afterEach, describe, expect, it } from 'vitest'

import { createSshRelayArtifactTestManifest } from '../../src/main/ssh/ssh-relay-artifact-test-manifest.ts'
import { verifySshRelayArtifactManifest } from '../../src/main/ssh/ssh-relay-manifest-signature.ts'
import { sshRelayRuntimeCompatibility } from './ssh-relay-runtime-compatibility.mjs'
import { computeSshRelayRuntimeContentId } from './ssh-relay-runtime-identity.mjs'
import {
  finalizeSshRelayRuntimeManifestAggregateCommand,
  parseSshRelayRuntimeManifestAggregateCommandArguments,
  prepareSshRelayRuntimeManifestAggregateCommand
} from './ssh-relay-runtime-manifest-aggregate-command.mjs'
import {
  encodeSshRelayRuntimeManifestSigningRequestArtifact,
  signSshRelayRuntimeManifestRequest
} from './ssh-relay-runtime-manifest-seed-signing.mjs'
import { sshRelayRuntimeManifestKeyId } from './ssh-relay-runtime-manifest-signing-handoff.mjs'

const temporaryDirectories = []
const keyPair = nacl.sign.keyPair.fromSeed(Uint8Array.from({ length: 32 }, (_, index) => index))
const TUPLES = [
  'linux-x64-glibc',
  'linux-arm64-glibc',
  'darwin-x64',
  'darwin-arm64',
  'win32-x64',
  'win32-arm64'
]

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function fileReference(name, bytes) {
  return { name, size: bytes.length, sha256: digest(bytes) }
}

function watcherPackage(tupleId) {
  return tupleId.startsWith('linux-')
    ? `@parcel/watcher-linux-${tupleId.split('-')[1]}-glibc`
    : `@parcel/watcher-${tupleId}`
}

function nativeEntry(path, role, marker) {
  return {
    path,
    type: 'file',
    role,
    size: marker.length,
    mode: 0o755,
    sha256: digest(marker)
  }
}

function tupleFor(tupleId) {
  const tuple = structuredClone(createSshRelayArtifactTestManifest().tuples[0])
  const [os, architecture] = tupleId.split('-')
  tuple.tupleId = tupleId
  tuple.os = os
  tuple.architecture = architecture
  tuple.compatibility = structuredClone(sshRelayRuntimeCompatibility[tupleId])
  const packageName = watcherPackage(tupleId)
  tuple.entries = tuple.entries.map((entry) => {
    const next = structuredClone(entry)
    next.path = next.path.replace('@parcel/watcher-linux-x64-glibc', packageName)
    if (next.role === 'node') {
      next.path = os === 'win32' ? 'bin/node.exe' : 'bin/node'
    }
    return next
  })
  if (os === 'darwin') {
    tuple.entries.push(
      nativeEntry(
        'node_modules/node-pty/build/Release/spawn-helper',
        'native-runtime',
        `${tupleId}:spawn-helper`
      )
    )
  }
  if (os === 'win32') {
    tuple.entries = tuple.entries.filter((entry) => entry.role !== 'node-pty-native')
    tuple.entries.push(
      { path: 'node_modules/node-pty/build/Release/conpty', type: 'directory', mode: 0o755 },
      nativeEntry(
        'node_modules/node-pty/build/Release/conpty.node',
        'node-pty-native',
        `${tupleId}:conpty-node`
      ),
      nativeEntry(
        'node_modules/node-pty/build/Release/conpty_console_list.node',
        'node-pty-native',
        `${tupleId}:console-list`
      ),
      nativeEntry(
        'node_modules/node-pty/build/Release/conpty/OpenConsole.exe',
        'native-runtime',
        `${tupleId}:open-console`
      ),
      nativeEntry(
        'node_modules/node-pty/build/Release/conpty/conpty.dll',
        'native-runtime',
        `${tupleId}:conpty-dll`
      )
    )
  }
  const nativeRoles = new Set([
    'node',
    'node-pty-native',
    'parcel-watcher-native',
    'native-runtime'
  ])
  tuple.nativeVerification = {
    policy:
      os === 'linux'
        ? 'linux-hash-only-v1'
        : os === 'darwin'
          ? 'apple-developer-id-v1'
          : 'signpath-authenticode-v1',
    tool: { name: 'fixture-verifier', version: '1.0.0' },
    verifiedAt: '2026-07-15T00:00:00.000Z',
    files: tuple.entries
      .filter((entry) => entry.type === 'file' && nativeRoles.has(entry.role))
      .map(({ path, sha256 }) => ({ path, sha256 }))
  }
  const files = tuple.entries.filter((entry) => entry.type === 'file')
  tuple.archive.fileCount = files.length
  tuple.archive.expandedSize = files.reduce((total, entry) => total + entry.size, 0)
  tuple.metadataAssets.sbom.name = `orca-ssh-relay-runtime-${tupleId}.spdx.json`
  tuple.metadataAssets.provenance.name = `orca-ssh-relay-runtime-${tupleId}.provenance.json`
  tuple.contentId = computeSshRelayRuntimeContentId(tuple)
  const extension = os === 'win32' ? 'zip' : 'tar.br'
  tuple.archive.name = `orca-ssh-relay-runtime-v1-${tupleId}-${tuple.contentId.slice(7)}.${extension}`
  return tuple
}

async function writeTupleArtifact(root, tupleId) {
  const tuple = tupleFor(tupleId)
  const archiveBytes = Buffer.from(`${tupleId}:archive`)
  const sbomBytes = Buffer.from(`${JSON.stringify({ spdxVersion: 'SPDX-2.3', tupleId })}\n`)
  const provenanceBytes = Buffer.from(`${JSON.stringify({ _type: 'in-toto', tupleId })}\n`)
  tuple.archive.size = archiveBytes.length
  tuple.archive.sha256 = digest(archiveBytes)
  tuple.metadataAssets.sbom = fileReference(tuple.metadataAssets.sbom.name, sbomBytes)
  tuple.metadataAssets.provenance = fileReference(
    tuple.metadataAssets.provenance.name,
    provenanceBytes
  )
  const descriptorBytes = Buffer.from(
    `${JSON.stringify({ schemaVersion: 1, tuple }, null, 2)}\n`,
    'utf8'
  )
  const input = {
    tupleId,
    descriptor: fileReference(
      `orca-ssh-relay-runtime-${tupleId}.manifest-tuple.json`,
      descriptorBytes
    ),
    archive: fileReference(tuple.archive.name, archiveBytes),
    sbom: { ...tuple.metadataAssets.sbom },
    provenance: { ...tuple.metadataAssets.provenance }
  }
  const artifactName = tupleId.startsWith('linux-')
    ? `ssh-relay-runtime-${tupleId}`
    : `ssh-relay-runtime-signed-${tupleId}`
  const artifactRoot = join(root, artifactName)
  const assetsRoot = tupleId.startsWith('linux-') ? artifactRoot : join(artifactRoot, 'assets')
  const evidenceRoot = tupleId.startsWith('linux-') ? artifactRoot : join(artifactRoot, 'evidence')
  await mkdir(assetsRoot, { recursive: true })
  await mkdir(evidenceRoot, { recursive: true })
  await Promise.all([
    writeFile(join(assetsRoot, input.descriptor.name), descriptorBytes),
    writeFile(join(assetsRoot, input.archive.name), archiveBytes),
    writeFile(join(assetsRoot, input.sbom.name), sbomBytes),
    writeFile(join(assetsRoot, input.provenance.name), provenanceBytes)
  ])
  const receipt = tupleId.startsWith('linux-')
    ? { tupleId, contentId: tuple.contentId, verification: {}, aggregateInput: input }
    : {
        tupleId,
        sourceContentId: tuple.contentId,
        finalContentId: tuple.contentId,
        returnedFiles: [],
        nativeVerification: tuple.nativeVerification,
        smoke: {},
        metadata: {},
        aggregateInput: input
      }
  const suffix = tupleId.startsWith('linux-') ? 'linux-finalization' : 'finalization'
  await writeFile(join(evidenceRoot, `${tupleId}.${suffix}.json`), `${JSON.stringify(receipt)}\n`)
  return { artifactRoot, assetsRoot, evidenceRoot, input, tuple }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-manifest-command-'))
  temporaryDirectories.push(root)
  const artifactsDirectory = join(root, 'artifacts')
  await mkdir(artifactsDirectory)
  const tuples = []
  for (const tupleId of TUPLES) {
    tuples.push(await writeTupleArtifact(artifactsDirectory, tupleId))
  }
  const acceptedKeysPath = join(root, 'accepted-keys.json')
  const acceptedKeys = {
    schemaVersion: 1,
    keys: [
      {
        keyId: sshRelayRuntimeManifestKeyId(keyPair.publicKey),
        publicKeyBase64: Buffer.from(keyPair.publicKey).toString('base64')
      }
    ]
  }
  await writeFile(acceptedKeysPath, `${JSON.stringify(acceptedKeys)}\n`)
  return {
    root,
    artifactsDirectory,
    acceptedKeysPath,
    acceptedKeys,
    tuples,
    prepareOutput: join(root, 'prepared'),
    finalOutput: join(root, 'final'),
    sourceSha: 'a'.repeat(40),
    releaseTag: 'v1.4.140-rc.1',
    createdAt: '2026-07-15T01:02:03.000Z',
    relayProtocolVersion: 1
  }
}

function commandInput(value, outputDirectory = value.prepareOutput) {
  return {
    artifactsDirectory: value.artifactsDirectory,
    acceptedKeysPath: value.acceptedKeysPath,
    outputDirectory,
    sourceSha: value.sourceSha,
    releaseTag: value.releaseTag,
    createdAt: value.createdAt,
    relayProtocolVersion: value.relayProtocolVersion
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('SSH relay runtime manifest aggregate filesystem command', () => {
  it('independently recollects six receipt-bound artifacts around signature-only handoff', async () => {
    const value = await fixture()
    const prepared = await prepareSshRelayRuntimeManifestAggregateCommand(commandInput(value))
    const requestArtifact = JSON.parse(
      await readFile(join(value.prepareOutput, 'signing-request.json'), 'utf8')
    )
    expect(requestArtifact).toEqual(
      encodeSshRelayRuntimeManifestSigningRequestArtifact(prepared.signingRequest)
    )
    const signingResult = signSshRelayRuntimeManifestRequest({
      requestArtifact,
      seedBase64: Buffer.from(keyPair.secretKey.subarray(0, 32)).toString('base64')
    })
    const signingResultPath = join(value.root, 'signing-result.json')
    await writeFile(signingResultPath, `${JSON.stringify(signingResult)}\n`)
    const finalized = await finalizeSshRelayRuntimeManifestAggregateCommand({
      ...commandInput(value, value.finalOutput),
      preparedDirectory: value.prepareOutput,
      signingResultPath
    })

    expect(finalized.manifest.tuples.map((tuple) => tuple.tupleId)).toEqual(TUPLES.toSorted())
    expect(
      verifySshRelayArtifactManifest(finalized.manifest, [
        { keyId: value.acceptedKeys.keys[0].keyId, publicKey: keyPair.publicKey }
      ])
    ).toEqual(finalized.manifest)
    const finalEntries = (await lstat(value.finalOutput)).isDirectory()
    expect(finalEntries).toBe(true)
    await expect(lstat(join(value.finalOutput, 'aggregate-input'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('rejects missing, extra, mutated, duplicate, and receipt-drifted artifact inputs', async () => {
    const missing = await fixture()
    await rm(missing.tuples[0].artifactRoot, { recursive: true })
    await expect(
      prepareSshRelayRuntimeManifestAggregateCommand(commandInput(missing))
    ).rejects.toThrow(/missing|unexpected/i)

    const extra = await fixture()
    await mkdir(join(extra.artifactsDirectory, 'ssh-relay-runtime-extra'))
    await expect(
      prepareSshRelayRuntimeManifestAggregateCommand(commandInput(extra))
    ).rejects.toThrow(/missing|unexpected/i)

    const mutated = await fixture()
    await writeFile(
      join(mutated.tuples[1].assetsRoot, mutated.tuples[1].input.archive.name),
      'drift'
    )
    await expect(
      prepareSshRelayRuntimeManifestAggregateCommand(commandInput(mutated))
    ).rejects.toThrow(/size|sha-?256|changed/i)

    const receiptDrift = await fixture()
    const receiptPath = join(receiptDrift.tuples[2].evidenceRoot, `${TUPLES[2]}.finalization.json`)
    const document = JSON.parse(await readFile(receiptPath, 'utf8'))
    document.tupleId = TUPLES[3]
    await writeFile(receiptPath, `${JSON.stringify(document)}\n`)
    await expect(
      prepareSshRelayRuntimeManifestAggregateCommand(commandInput(receiptDrift))
    ).rejects.toThrow(/receipt|tuple/i)

    const duplicate = await fixture()
    const duplicateReceiptPath = join(
      duplicate.tuples[1].evidenceRoot,
      `${TUPLES[1]}.linux-finalization.json`
    )
    const duplicateReceipt = JSON.parse(await readFile(duplicateReceiptPath, 'utf8'))
    duplicateReceipt.aggregateInput.archive.name = duplicate.tuples[0].input.archive.name
    await writeFile(duplicateReceiptPath, `${JSON.stringify(duplicateReceipt)}\n`)
    await expect(
      prepareSshRelayRuntimeManifestAggregateCommand(commandInput(duplicate))
    ).rejects.toThrow(/duplicate/i)
  })

  it.skipIf(process.platform === 'win32')('rejects linked finalization receipts', async () => {
    const linked = await fixture()
    const receipt = join(linked.tuples[0].evidenceRoot, `${TUPLES[0]}.linux-finalization.json`)
    const realReceipt = `${receipt}.real`
    await writeFile(realReceipt, await readFile(receipt))
    await rm(receipt)
    await symlink(realReceipt, receipt)
    await expect(
      prepareSshRelayRuntimeManifestAggregateCommand(commandInput(linked))
    ).rejects.toThrow(/regular|symbolic|link/i)
  })

  it('validates accepted keys before exposing a request and removes partial final output', async () => {
    const invalidKeys = await fixture()
    invalidKeys.acceptedKeys.keys[0].publicKeyBase64 = Buffer.alloc(31).toString('base64')
    await writeFile(invalidKeys.acceptedKeysPath, JSON.stringify(invalidKeys.acceptedKeys))
    await expect(
      prepareSshRelayRuntimeManifestAggregateCommand(commandInput(invalidKeys))
    ).rejects.toThrow(/public key|32 bytes|accepted key/i)
    await expect(lstat(invalidKeys.prepareOutput)).rejects.toMatchObject({ code: 'ENOENT' })

    const invalidSignature = await fixture()
    await prepareSshRelayRuntimeManifestAggregateCommand(commandInput(invalidSignature))
    const signingResultPath = join(invalidSignature.root, 'signing-result.json')
    await writeFile(
      signingResultPath,
      JSON.stringify({
        keyId: invalidSignature.acceptedKeys.keys[0].keyId,
        signature: Buffer.alloc(64).toString('base64')
      })
    )
    await expect(
      finalizeSshRelayRuntimeManifestAggregateCommand({
        ...commandInput(invalidSignature, invalidSignature.finalOutput),
        preparedDirectory: invalidSignature.prepareOutput,
        signingResultPath
      })
    ).rejects.toThrow(/signature/i)
    await expect(lstat(invalidSignature.finalOutput)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects prepared handoff drift, cancellation, and incomplete CLI arguments', async () => {
    const drifted = await fixture()
    const prepared = await prepareSshRelayRuntimeManifestAggregateCommand(commandInput(drifted))
    const requestArtifact = encodeSshRelayRuntimeManifestSigningRequestArtifact(
      prepared.signingRequest
    )
    const signingResultPath = join(drifted.root, 'signing-result.json')
    await writeFile(
      signingResultPath,
      JSON.stringify({
        ...signSshRelayRuntimeManifestRequest({
          requestArtifact,
          seedBase64: Buffer.from(keyPair.secretKey.subarray(0, 32)).toString('base64')
        })
      })
    )
    const preparedPath = join(drifted.prepareOutput, 'prepared-aggregate.json')
    const preparedDocument = JSON.parse(await readFile(preparedPath, 'utf8'))
    preparedDocument.sourceSha = 'b'.repeat(40)
    await writeFile(preparedPath, `${JSON.stringify(preparedDocument)}\n`)
    await expect(
      finalizeSshRelayRuntimeManifestAggregateCommand({
        ...commandInput(drifted, drifted.finalOutput),
        preparedDirectory: drifted.prepareOutput,
        signingResultPath
      })
    ).rejects.toThrow(/prepared|drift/i)
    await expect(lstat(drifted.finalOutput)).rejects.toMatchObject({ code: 'ENOENT' })

    const cancelled = await fixture()
    const controller = new AbortController()
    controller.abort(new Error('cancel aggregate collection'))
    await expect(
      prepareSshRelayRuntimeManifestAggregateCommand({
        ...commandInput(cancelled),
        signal: controller.signal
      })
    ).rejects.toThrow(/cancel aggregate collection/i)
    await expect(lstat(cancelled.prepareOutput)).rejects.toMatchObject({ code: 'ENOENT' })

    expect(() => parseSshRelayRuntimeManifestAggregateCommandArguments(['prepare'])).toThrow(
      /missing/i
    )
    expect(() =>
      parseSshRelayRuntimeManifestAggregateCommandArguments(['finalize', '--unknown', 'value'])
    ).toThrow(/invalid/i)
  })
})
