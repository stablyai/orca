import { createHash } from 'node:crypto'

import nacl from 'tweetnacl'

import {
  parseSshRelayArtifactManifest,
  parseSshRelayUnsignedArtifactManifest,
  type SshRelayArtifactManifest,
  type SshRelayManifestSignature,
  type SshRelayRuntimeTuple,
  type SshRelayUnsignedArtifactManifest
} from './ssh-relay-artifact-schema'
import type {
  SshRelayDigest,
  SshRelayRuntimeCompatibility,
  SshRelayRuntimeEntry
} from './ssh-relay-runtime-identity'

export type SshRelayManifestAcceptedKey = {
  keyId: SshRelayDigest
  publicKey: Uint8Array
}

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T

declare const verifiedSshRelayManifest: unique symbol

export type VerifiedSshRelayArtifactManifest = DeepReadonly<SshRelayArtifactManifest> & {
  readonly [verifiedSshRelayManifest]: true
}

function deepFreezeManifest<T extends object>(value: T): DeepReadonly<T> {
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === 'object' && !Object.isFrozen(nested)) {
      deepFreezeManifest(nested)
    }
  }
  return Object.freeze(value) as DeepReadonly<T>
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function canonicalCompatibility(compatibility: SshRelayRuntimeCompatibility): object {
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

function canonicalEntry(entry: SshRelayRuntimeEntry): object {
  if (entry.type === 'directory') {
    return { path: entry.path, type: entry.type, mode: entry.mode }
  }
  return {
    path: entry.path,
    type: entry.type,
    role: entry.role,
    size: entry.size,
    mode: entry.mode,
    sha256: entry.sha256
  }
}

function canonicalTuple(tuple: SshRelayRuntimeTuple): object {
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

export function canonicalUnsignedSshRelayManifestBytes(input: unknown): Buffer {
  const manifest = parseSshRelayUnsignedArtifactManifest(input)
  // Why: signatures authenticate a fixed validated projection, never caller insertion order or
  // signature-array contents that could vary during key rotation.
  const unsignedProjection = {
    schemaVersion: manifest.schemaVersion,
    build: {
      tag: manifest.build.tag,
      channel: manifest.build.channel,
      version: manifest.build.version,
      relayProtocolVersion: manifest.build.relayProtocolVersion
    },
    createdAt: manifest.createdAt,
    tuples: [...manifest.tuples]
      .sort((left, right) => compareAscii(left.tupleId, right.tupleId))
      .map(canonicalTuple)
  }
  return Buffer.from(JSON.stringify(unsignedProjection), 'utf8')
}

export function sshRelayManifestKeyId(publicKey: Uint8Array): SshRelayDigest {
  if (publicKey.byteLength !== nacl.sign.publicKeyLength) {
    throw new Error('SSH relay manifest Ed25519 public key must be 32 bytes')
  }
  return `sha256:${createHash('sha256').update(publicKey).digest('hex')}`
}

export function signSshRelayArtifactManifest(
  manifest: SshRelayArtifactManifest | SshRelayUnsignedArtifactManifest,
  secretKey: Uint8Array
): SshRelayManifestSignature {
  if (secretKey.byteLength !== nacl.sign.secretKeyLength) {
    throw new Error('SSH relay manifest Ed25519 secret key must be 64 bytes')
  }
  const publicKey = nacl.sign.keyPair.fromSecretKey(secretKey).publicKey
  const signature = nacl.sign.detached(canonicalUnsignedSshRelayManifestBytes(manifest), secretKey)
  return {
    algorithm: 'ed25519-v1',
    keyId: sshRelayManifestKeyId(publicKey),
    signature: Buffer.from(signature).toString('base64')
  }
}

function acceptedKeyMap(keys: readonly SshRelayManifestAcceptedKey[]): Map<string, Uint8Array> {
  const accepted = new Map<string, Uint8Array>()
  for (const key of keys) {
    const derivedKeyId = sshRelayManifestKeyId(key.publicKey)
    if (key.keyId !== derivedKeyId) {
      throw new Error(`SSH relay manifest public key ID does not match key bytes: ${key.keyId}`)
    }
    if (accepted.has(key.keyId)) {
      throw new Error(`Duplicate accepted SSH relay manifest key: ${key.keyId}`)
    }
    accepted.set(key.keyId, key.publicKey)
  }
  return accepted
}

export function verifySshRelayArtifactManifest(
  input: unknown,
  acceptedKeys: readonly SshRelayManifestAcceptedKey[]
): VerifiedSshRelayArtifactManifest {
  const manifest = parseSshRelayArtifactManifest(input)
  const unsignedBytes = canonicalUnsignedSshRelayManifestBytes(manifest)
  const keys = acceptedKeyMap(acceptedKeys)
  let validAcceptedSignatures = 0

  for (const signature of manifest.signatures) {
    const publicKey = keys.get(signature.keyId)
    if (!publicKey) {
      throw new Error(`Unknown signing key in SSH relay manifest: ${signature.keyId}`)
    }
    const signatureBytes = Buffer.from(signature.signature, 'base64')
    if (!nacl.sign.detached.verify(unsignedBytes, signatureBytes, publicKey)) {
      throw new Error(`Invalid SSH relay manifest signature from key: ${signature.keyId}`)
    }
    validAcceptedSignatures += 1
  }

  if (validAcceptedSignatures === 0) {
    throw new Error('SSH relay manifest requires at least one valid accepted signature')
  }
  // Why: a branded manifest must not be mutable after verification or later consumers could trust
  // fields whose bytes were never authenticated by the accepted signature.
  return deepFreezeManifest(manifest) as VerifiedSshRelayArtifactManifest
}
