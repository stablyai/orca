import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib'

import nacl from 'tweetnacl'
import yazl from 'yazl'

import type { SshRelayArtifactManifest, SshRelayRuntimeTuple } from './ssh-relay-artifact-schema'
import {
  createSshRelayArtifactTestManifest,
  createSshRelayWindowsArtifactTestManifest
} from './ssh-relay-artifact-test-manifest'
import {
  selectSshRelayArtifact,
  type SshRelayHostEvidence,
  type SshRelaySelectedArtifact
} from './ssh-relay-artifact-selector'
import type { SshRelayOfficialManifest } from './ssh-relay-official-manifest'
import {
  signSshRelayArtifactManifest,
  sshRelayManifestKeyId,
  verifySshRelayArtifactManifest
} from './ssh-relay-manifest-signature'
import { sshRelayRuntimeArchiveName } from './ssh-relay-release-asset'
import { computeSshRelayRuntimeContentId, type SshRelayDigest } from './ssh-relay-runtime-identity'

const keyPair = nacl.sign.keyPair.fromSeed(Uint8Array.from({ length: 32 }, (_, index) => index))

function sha256(bytes: Uint8Array): SshRelayDigest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function tarOctal(header: Buffer, value: number, offset: number, length: number): void {
  header.write(value.toString(8).padStart(length - 1, '0'), offset, length - 1, 'ascii')
  header[offset + length - 1] = 0
}

function tarHeader(entry: SshRelayRuntimeTuple['entries'][number], size: number): Buffer {
  const header = Buffer.alloc(512)
  header.write(entry.type === 'directory' ? `${entry.path}/` : entry.path, 0, 100, 'utf8')
  tarOctal(header, entry.mode, 100, 8)
  tarOctal(header, 0, 108, 8)
  tarOctal(header, 0, 116, 8)
  tarOctal(header, size, 124, 12)
  tarOctal(header, 0, 136, 12)
  header.fill(0x20, 148, 156)
  header[156] = entry.type === 'directory' ? 0x35 : 0x30
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  const checksum = header.reduce((total, byte) => total + byte, 0)
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return header
}

function tarBrotli(tuple: SshRelayRuntimeTuple, fileBytes: ReadonlyMap<string, Buffer>): Buffer {
  const blocks: Buffer[] = []
  for (const entry of tuple.entries) {
    const bytes = entry.type === 'file' ? fileBytes.get(entry.path) : undefined
    if (entry.type === 'file' && !bytes) {
      throw new Error(`Missing cache fixture bytes for ${entry.path}`)
    }
    blocks.push(tarHeader(entry, bytes?.length ?? 0))
    if (bytes) {
      blocks.push(bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512))
    }
  }
  blocks.push(Buffer.alloc(1024))
  return brotliCompressSync(Buffer.concat(blocks), {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 9,
      [zlibConstants.BROTLI_PARAM_LGWIN]: 20
    }
  })
}

async function zipArchive(
  tuple: SshRelayRuntimeTuple,
  fileBytes: ReadonlyMap<string, Buffer>
): Promise<Buffer> {
  const zip = new yazl.ZipFile()
  const mtime = new Date('2026-07-14T00:00:00.000Z')
  for (const entry of tuple.entries) {
    const options = { mode: entry.mode, mtime, forceDosTimestamp: true }
    if (entry.type === 'directory') {
      zip.addEmptyDirectory(entry.path, options)
      continue
    }
    const bytes = fileBytes.get(entry.path)
    if (!bytes) {
      throw new Error(`Missing cache fixture bytes for ${entry.path}`)
    }
    zip.addBuffer(bytes, entry.path, { ...options, compress: true, compressionLevel: 9 })
  }
  zip.end({ forceZip64Format: false })
  const chunks: Buffer[] = []
  for await (const chunk of zip.outputStream) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

export type SshRelayArtifactCacheEntryFixture = {
  archivePath: string
  artifact: SshRelaySelectedArtifact
  fileBytes: ReadonlyMap<string, Buffer>
  host: SshRelayHostEvidence
  officialManifest: SshRelayOfficialManifest
}

export async function createSshRelayArtifactCacheEntryFixture({
  root,
  os,
  fileBytes: fileByteOverrides = new Map()
}: {
  root: string
  os: 'linux' | 'win32'
  fileBytes?: ReadonlyMap<string, Buffer>
}): Promise<SshRelayArtifactCacheEntryFixture> {
  const manifest: SshRelayArtifactManifest =
    os === 'win32'
      ? createSshRelayWindowsArtifactTestManifest()
      : createSshRelayArtifactTestManifest()
  const tuple = manifest.tuples[0]
  const fileBytes = new Map<string, Buffer>()
  for (const entry of tuple.entries) {
    if (entry.type !== 'file') {
      continue
    }
    const bytes =
      fileByteOverrides.get(entry.path) ??
      Buffer.from(`cache entry fixture:${tuple.tupleId}:${entry.path}`)
    fileBytes.set(entry.path, bytes)
    entry.size = bytes.length
    entry.sha256 = sha256(bytes)
  }
  for (const attestation of tuple.nativeVerification.files) {
    const entry = tuple.entries.find((candidate) => candidate.path === attestation.path)
    if (!entry || entry.type !== 'file') {
      throw new Error(`Missing attested cache fixture entry: ${attestation.path}`)
    }
    attestation.sha256 = entry.sha256
  }
  tuple.contentId = computeSshRelayRuntimeContentId(tuple)
  tuple.archive.name = sshRelayRuntimeArchiveName(tuple.tupleId, tuple.contentId)
  const files = tuple.entries.filter((entry) => entry.type === 'file')
  tuple.archive.fileCount = files.length
  tuple.archive.expandedSize = files.reduce((total, entry) => total + entry.size, 0)
  const archive = os === 'win32' ? await zipArchive(tuple, fileBytes) : tarBrotli(tuple, fileBytes)
  tuple.archive.size = archive.length
  tuple.archive.sha256 = sha256(archive)
  manifest.signatures = [signSshRelayArtifactManifest(manifest, keyPair.secretKey)]
  const verified = verifySshRelayArtifactManifest(manifest, [
    { keyId: sshRelayManifestKeyId(keyPair.publicKey), publicKey: keyPair.publicKey }
  ])
  const host: SshRelayHostEvidence =
    os === 'win32'
      ? {
          os,
          architecture: 'x64',
          processTranslated: false,
          build: 22631,
          openSshVersion: '9.5p1',
          powerShellVersion: '5.1',
          dotNetFrameworkRelease: 528040
        }
      : {
          os,
          architecture: 'x64',
          processTranslated: false,
          kernelVersion: '6.8',
          libc: { family: 'glibc', version: '2.39' },
          libstdcxxVersion: '6.0.33',
          glibcxxVersion: '3.4.33'
        }
  const artifact = selectSshRelayArtifact(verified, host)
  if (artifact.kind !== 'selected') {
    throw new Error(`Expected selected cache fixture, got ${artifact.reason}`)
  }
  const archivePath = join(root, tuple.archive.name)
  await writeFile(archivePath, archive, { mode: 0o600 })
  return {
    archivePath,
    artifact,
    fileBytes,
    host,
    officialManifest: Object.freeze({
      manifest: verified,
      acceptedKeysSha256: sha256(keyPair.publicKey)
    })
  }
}
