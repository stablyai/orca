import { createHash } from 'node:crypto'

import { parseSshRelayRuntimeUnsignedManifest } from './ssh-relay-runtime-manifest-validation.mjs'

// Why: this exceeds the eight-tuple entry/attestation maximum while bounding signer input memory.
const MAX_CANONICAL_BYTES = 32 * 1024 * 1024

function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function canonicalCompatibility(compatibility) {
  if (compatibility.kind === 'linux') {
    return {
      kind: compatibility.kind,
      minimumKernelVersion: compatibility.minimumKernelVersion,
      libc: {
        family: compatibility.libc.family,
        minimumVersion: compatibility.libc.minimumVersion,
        minimumLibstdcxxVersion: compatibility.libc.minimumLibstdcxxVersion,
        minimumGlibcxxVersion: compatibility.libc.minimumGlibcxxVersion
      }
    }
  }
  if (compatibility.kind === 'darwin') {
    return { kind: compatibility.kind, minimumVersion: compatibility.minimumVersion }
  }
  return {
    kind: compatibility.kind,
    minimumBuild: compatibility.minimumBuild,
    minimumOpenSshVersion: compatibility.minimumOpenSshVersion,
    minimumPowerShellVersion: compatibility.minimumPowerShellVersion,
    minimumDotNetFrameworkRelease: compatibility.minimumDotNetFrameworkRelease
  }
}

function canonicalEntry(entry) {
  return entry.type === 'directory'
    ? { path: entry.path, type: entry.type, mode: entry.mode }
    : {
        path: entry.path,
        type: entry.type,
        role: entry.role,
        size: entry.size,
        mode: entry.mode,
        sha256: entry.sha256
      }
}

function canonicalTuple(tuple) {
  return {
    tupleId: tuple.tupleId,
    os: tuple.os,
    architecture: tuple.architecture,
    compatibility: canonicalCompatibility(tuple.compatibility),
    nodeVersion: tuple.nodeVersion,
    dependencies: {
      nodePtyVersion: tuple.dependencies.nodePtyVersion,
      parcelWatcherVersion: tuple.dependencies.parcelWatcherVersion
    },
    entries: [...tuple.entries]
      .sort((left, right) => compareAscii(left.path, right.path))
      .map(canonicalEntry),
    contentId: tuple.contentId,
    archive: {
      name: tuple.archive.name,
      size: tuple.archive.size,
      expandedSize: tuple.archive.expandedSize,
      fileCount: tuple.archive.fileCount,
      sha256: tuple.archive.sha256
    },
    metadataAssets: {
      sbom: {
        name: tuple.metadataAssets.sbom.name,
        size: tuple.metadataAssets.sbom.size,
        sha256: tuple.metadataAssets.sbom.sha256
      },
      provenance: {
        name: tuple.metadataAssets.provenance.name,
        size: tuple.metadataAssets.provenance.size,
        sha256: tuple.metadataAssets.provenance.sha256
      }
    },
    nativeVerification: {
      policy: tuple.nativeVerification.policy,
      tool: {
        name: tuple.nativeVerification.tool.name,
        version: tuple.nativeVerification.tool.version
      },
      verifiedAt: tuple.nativeVerification.verifiedAt,
      files: [...tuple.nativeVerification.files]
        .sort((left, right) => compareAscii(left.path, right.path))
        .map((file) => ({ path: file.path, sha256: file.sha256 }))
    }
  }
}

export function assembleCanonicalSshRelayRuntimeManifest(input) {
  const parsed = parseSshRelayRuntimeUnsignedManifest(input)
  // Why: release and desktop verification must authenticate one fixed projection across runners.
  const manifest = {
    schemaVersion: parsed.schemaVersion,
    build: {
      tag: parsed.build.tag,
      channel: parsed.build.channel,
      version: parsed.build.version,
      relayProtocolVersion: parsed.build.relayProtocolVersion
    },
    createdAt: parsed.createdAt,
    tuples: [...parsed.tuples]
      .sort((left, right) => compareAscii(left.tupleId, right.tupleId))
      .map(canonicalTuple)
  }
  const canonicalBytes = Buffer.from(JSON.stringify(manifest), 'utf8')
  if (canonicalBytes.length === 0 || canonicalBytes.length > MAX_CANONICAL_BYTES) {
    throw new Error('SSH relay runtime canonical manifest exceeds its size limit')
  }
  return {
    manifest,
    canonicalBytes,
    sha256: `sha256:${createHash('sha256').update(canonicalBytes).digest('hex')}`
  }
}

export function parseCanonicalSshRelayRuntimeManifestBytes(input) {
  if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) {
    throw new Error('SSH relay runtime canonical manifest must be bytes')
  }
  const bytes = Buffer.from(input)
  if (bytes.length === 0 || bytes.length > MAX_CANONICAL_BYTES) {
    throw new Error('SSH relay runtime canonical manifest exceeds its size limit')
  }
  let source
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('SSH relay runtime canonical manifest must be valid UTF-8')
  }
  let inputManifest
  try {
    inputManifest = JSON.parse(source)
  } catch {
    throw new Error('SSH relay runtime canonical manifest must be valid JSON')
  }
  const assembled = assembleCanonicalSshRelayRuntimeManifest(inputManifest)
  if (!assembled.canonicalBytes.equals(bytes)) {
    throw new Error('SSH relay runtime manifest bytes are not the canonical unsigned projection')
  }
  return assembled.manifest
}

export { MAX_CANONICAL_BYTES as SSH_RELAY_RUNTIME_MAX_CANONICAL_MANIFEST_BYTES }
