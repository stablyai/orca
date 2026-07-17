import { createHash } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createSshRelayRuntimeSbom } from './ssh-relay-runtime-sbom.mjs'
import { assertSshRelayRuntimeToolchain } from './ssh-relay-runtime-toolchain.mjs'

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

async function writeJson(path, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
  return { name: path.split(/[\\/]/).at(-1), size: bytes.length, sha256: sha256(bytes) }
}

export function createSshRelayRuntimeProvenance({
  identity,
  archive,
  nodeRelease,
  sourceDateEpoch,
  gitCommit,
  builder,
  runner,
  toolchain
}) {
  assertSshRelayRuntimeToolchain(toolchain, identity.tupleId)
  const nativeFiles = identity.entries
    .filter(
      (entry) =>
        entry.type === 'file' &&
        ['node', 'node-pty-native', 'parcel-watcher-native', 'native-runtime'].includes(entry.role)
    )
    .map((entry) => ({ path: entry.path, sha256: entry.sha256 }))
  const resolvedDependencies = [
    {
      uri: `${nodeRelease.baseUrl}/${nodeRelease.archives[identity.tupleId].name}`,
      digest: { sha256: nodeRelease.archives[identity.tupleId].sha256 }
    },
    {
      uri: nodeRelease.signature.key.sourceUrl,
      digest: { sha256: nodeRelease.signature.key.sha256 }
    },
    { uri: `git+https://github.com/stablyai/orca@${gitCommit}`, digest: { gitCommit } }
  ]
  if (identity.tupleId.startsWith('win32-')) {
    const headers = nodeRelease.windowsBuildInputs.headersArchive
    const library = nodeRelease.windowsBuildInputs.importLibraries[identity.tupleId]
    resolvedDependencies.splice(
      1,
      0,
      { uri: `${nodeRelease.baseUrl}/${headers.name}`, digest: { sha256: headers.sha256 } },
      { uri: `${nodeRelease.baseUrl}/${library.name}`, digest: { sha256: library.sha256 } }
    )
  }
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: archive.name, digest: { sha256: archive.sha256.slice('sha256:'.length) } }],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        buildType: 'https://github.com/stablyai/orca/ssh-relay-runtime-build/v1',
        externalParameters: {
          tuple: identity.tupleId,
          nodeVersion: identity.nodeVersion,
          contentId: identity.contentId,
          sourceDateEpoch
        },
        internalParameters: { toolchain },
        resolvedDependencies
      },
      runDetails: {
        builder: { id: builder },
        metadata: {
          invocationId: process.env.GITHUB_RUN_ID ?? 'local-unpublished-build',
          runner
        },
        byproducts: [{ name: 'native-files', content: nativeFiles }]
      }
    }
  }
}

export async function writeSshRelayRuntimeMetadata({
  outputDirectory,
  identity,
  archive,
  nodeRelease,
  sourceDateEpoch,
  gitCommit,
  builder,
  runner,
  toolchain
}) {
  const sbomName = `orca-ssh-relay-runtime-${identity.tupleId}.spdx.json`
  const provenanceName = `orca-ssh-relay-runtime-${identity.tupleId}.provenance.json`
  const identityName = `orca-ssh-relay-runtime-${identity.tupleId}.identity.json`
  const sbom = createSshRelayRuntimeSbom({ identity, archive, sourceDateEpoch })
  const provenance = createSshRelayRuntimeProvenance({
    identity,
    archive,
    nodeRelease,
    sourceDateEpoch,
    gitCommit,
    builder,
    runner,
    toolchain
  })
  const identityDocument = {
    ...identity,
    archive: {
      name: archive.name,
      size: archive.size,
      expandedSize: identity.expandedSize,
      fileCount: identity.fileCount,
      sha256: archive.sha256
    }
  }
  const [sbomAsset, provenanceAsset, identityAsset] = await Promise.all([
    writeJson(join(outputDirectory, sbomName), sbom),
    writeJson(join(outputDirectory, provenanceName), provenance),
    writeJson(join(outputDirectory, identityName), identityDocument)
  ])
  for (const asset of [sbomAsset, provenanceAsset, identityAsset]) {
    const metadata = await stat(join(outputDirectory, asset.name))
    const bytes = await readFile(join(outputDirectory, asset.name))
    if (metadata.size !== asset.size || sha256(bytes) !== asset.sha256) {
      throw new Error(`Runtime metadata changed while being finalized: ${asset.name}`)
    }
  }
  return { sbom: sbomAsset, provenance: provenanceAsset, identity: identityAsset }
}
