import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib'

import nacl from 'tweetnacl'
import { afterEach, describe, expect, it } from 'vitest'
import yazl from 'yazl'

import {
  extractSshRelayArtifact,
  SSH_RELAY_ARTIFACT_EXTRACTION_LIMITS
} from './ssh-relay-artifact-extraction'
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
import {
  signSshRelayArtifactManifest,
  sshRelayManifestKeyId,
  verifySshRelayArtifactManifest
} from './ssh-relay-manifest-signature'
import { sshRelayRuntimeArchiveName } from './ssh-relay-release-asset'
import { computeSshRelayRuntimeContentId, type SshRelayDigest } from './ssh-relay-runtime-identity'

const keyPair = nacl.sign.keyPair.fromSeed(Uint8Array.from({ length: 32 }, (_, index) => index))
const temporaryDirectories: string[] = []
type TarFault = 'checksum' | 'padding' | 'end-marker' | 'extra-end-block'

function sha256(bytes: Uint8Array): SshRelayDigest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function tarString(header: Buffer, value: string, offset: number, length: number): void {
  header.write(value, offset, length, 'utf8')
}

function tarOctal(header: Buffer, value: number, offset: number, length: number): void {
  header.write(value.toString(8).padStart(length - 1, '0'), offset, length - 1, 'ascii')
  header[offset + length - 1] = 0
}

function tarHeader(entry: SshRelayRuntimeTuple['entries'][number], size: number): Buffer {
  const header = Buffer.alloc(512)
  tarString(header, entry.type === 'directory' ? `${entry.path}/` : entry.path, 0, 100)
  tarOctal(header, entry.mode, 100, 8)
  tarOctal(header, 0, 108, 8)
  tarOctal(header, 0, 116, 8)
  tarOctal(header, size, 124, 12)
  tarOctal(header, 0, 136, 12)
  header.fill(0x20, 148, 156)
  header[156] = entry.type === 'directory' ? 0x35 : 0x30
  tarString(header, 'ustar\0', 257, 6)
  tarString(header, '00', 263, 2)
  const checksum = header.reduce((total, byte) => total + byte, 0)
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return header
}

function tarBrotli(
  tuple: SshRelayRuntimeTuple,
  fileBytes: ReadonlyMap<string, Buffer>,
  {
    extraPath,
    fault
  }: {
    extraPath?: string
    fault?: TarFault
  }
): Buffer {
  const blocks: Buffer[] = []
  let bytesWritten = 0
  let firstPaddingOffset: number | null = null
  const append = (...values: Buffer[]): void => {
    for (const value of values) {
      blocks.push(value)
      bytesWritten += value.length
    }
  }
  for (const entry of tuple.entries) {
    const bytes = entry.type === 'file' ? fileBytes.get(entry.path) : undefined
    if (entry.type === 'file' && !bytes) {
      throw new Error(`Missing test bytes for ${entry.path}`)
    }
    append(tarHeader(entry, bytes?.length ?? 0))
    if (bytes) {
      append(bytes)
      const padding = Buffer.alloc((512 - (bytes.length % 512)) % 512)
      if (padding.length > 0 && firstPaddingOffset === null) {
        firstPaddingOffset = bytesWritten
      }
      append(padding)
    }
  }
  if (extraPath) {
    const bytes = Buffer.from('undeclared archive bytes')
    append(
      tarHeader(
        {
          path: extraPath,
          type: 'file',
          role: 'license',
          mode: 0o644,
          size: 0,
          sha256: sha256(bytes)
        },
        bytes.length
      ),
      bytes,
      Buffer.alloc((512 - (bytes.length % 512)) % 512)
    )
  }
  append(Buffer.alloc(fault === 'end-marker' ? 512 : fault === 'extra-end-block' ? 1536 : 1024))
  const tar = Buffer.concat(blocks)
  if (fault === 'checksum') {
    tar[0] ^= 0x01
  } else if (fault === 'padding') {
    if (firstPaddingOffset === null) {
      throw new Error('TAR fault fixture requires file padding')
    }
    tar[firstPaddingOffset] = 0x01
  }
  return brotliCompressSync(tar, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 9,
      [zlibConstants.BROTLI_PARAM_LGWIN]: 20
    }
  })
}

async function zipArchive(
  tuple: SshRelayRuntimeTuple,
  fileBytes: ReadonlyMap<string, Buffer>,
  {
    extraPath,
    symlinkPath
  }: {
    extraPath?: string
    symlinkPath?: string
  }
): Promise<Buffer> {
  const zip = new yazl.ZipFile()
  const mtime = new Date('2026-07-14T00:00:00.000Z')
  for (const entry of tuple.entries) {
    const options = { mode: entry.mode, mtime, forceDosTimestamp: true }
    if (entry.type === 'directory') {
      zip.addEmptyDirectory(entry.path, options)
    } else {
      const bytes = fileBytes.get(entry.path)
      if (!bytes) {
        throw new Error(`Missing test bytes for ${entry.path}`)
      }
      zip.addBuffer(bytes, entry.path, {
        ...options,
        mode: entry.path === symlinkPath ? 0o120777 : entry.mode,
        compress: true,
        compressionLevel: 9
      })
    }
  }
  if (extraPath) {
    zip.addBuffer(Buffer.from('undeclared archive bytes'), extraPath, {
      mode: 0o644,
      mtime,
      forceDosTimestamp: true
    })
  }
  zip.end({ forceZip64Format: false })
  const chunks: Buffer[] = []
  for await (const chunk of zip.outputStream) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

function markZipEntriesEncrypted(archive: Buffer): Buffer {
  const changed = Buffer.from(archive)
  for (let offset = 0; offset <= changed.length - 10; offset += 1) {
    const signature = changed.readUInt32LE(offset)
    const flagOffset =
      signature === 0x04034b50 ? offset + 6 : signature === 0x02014b50 ? offset + 8 : -1
    if (flagOffset >= 0) {
      changed.writeUInt16LE(changed.readUInt16LE(flagOffset) | 0x0001, flagOffset)
    }
  }
  return changed
}

type Fixture = {
  archivePath: string
  artifact: SshRelaySelectedArtifact
  fileBytes: ReadonlyMap<string, Buffer>
  root: string
}

async function fixture({
  os,
  mismatchedPath,
  extraPath,
  largeFileBytes,
  truncated,
  encryptedZip,
  symlinkPath,
  tarFault
}: {
  os: 'linux' | 'win32'
  mismatchedPath?: string
  extraPath?: string
  largeFileBytes?: number
  truncated?: boolean
  encryptedZip?: boolean
  symlinkPath?: string
  tarFault?: TarFault
}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'orca-relay-extraction-'))
  temporaryDirectories.push(root)
  const manifest: SshRelayArtifactManifest =
    os === 'win32'
      ? createSshRelayWindowsArtifactTestManifest()
      : createSshRelayArtifactTestManifest()
  const tuple = manifest.tuples[0]
  const fileBytes = new Map<string, Buffer>()
  const firstFilePath = tuple.entries.find((entry) => entry.type === 'file')?.path
  for (const entry of tuple.entries) {
    if (entry.type !== 'file') {
      continue
    }
    const bytes =
      entry.path === firstFilePath && largeFileBytes
        ? Buffer.alloc(largeFileBytes, 0x61)
        : Buffer.from(`desktop extraction fixture:${tuple.tupleId}:${entry.path}`)
    fileBytes.set(entry.path, bytes)
    entry.size = bytes.length
    entry.sha256 = sha256(bytes)
  }
  for (const attestation of tuple.nativeVerification.files) {
    const entry = tuple.entries.find((candidate) => candidate.path === attestation.path)
    if (!entry || entry.type !== 'file') {
      throw new Error(`Missing attested fixture entry: ${attestation.path}`)
    }
    attestation.sha256 = entry.sha256
  }
  tuple.contentId = computeSshRelayRuntimeContentId(tuple)
  tuple.archive.name = sshRelayRuntimeArchiveName(tuple.tupleId, tuple.contentId)
  const files = tuple.entries.filter((entry) => entry.type === 'file')
  tuple.archive.fileCount = files.length
  tuple.archive.expandedSize = files.reduce((total, entry) => total + entry.size, 0)

  const archiveFileBytes = new Map(fileBytes)
  if (mismatchedPath) {
    archiveFileBytes.set(mismatchedPath, Buffer.from('authenticated archive has wrong tree bytes'))
  }
  let archive =
    os === 'win32'
      ? await zipArchive(tuple, archiveFileBytes, { extraPath, symlinkPath })
      : tarBrotli(tuple, archiveFileBytes, { extraPath, fault: tarFault })
  if (encryptedZip) {
    archive = markZipEntriesEncrypted(archive)
  }
  if (truncated) {
    archive = archive.subarray(0, Math.max(1, archive.length - 64))
  }
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
  const selected = selectSshRelayArtifact(verified, host)
  if (selected.kind !== 'selected') {
    throw new Error(`Expected selected fixture, got ${selected.reason}`)
  }
  const archivePath = join(root, tuple.archive.name)
  await writeFile(archivePath, archive, { mode: 0o600 })
  return { archivePath, artifact: selected, fileBytes, root }
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 5_000
  for (;;) {
    try {
      await stat(path)
      return
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
        throw error
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for test path: ${path}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('SSH relay artifact extraction', () => {
  it('declares the desktop extraction resource contract', () => {
    expect(SSH_RELAY_ARTIFACT_EXTRACTION_LIMITS).toEqual({
      timeoutMs: 2 * 60_000,
      chunkBytes: 64 * 1024,
      maximumIncrementalMemoryBytes: 80 * 1024 * 1024,
      maximumWriteBufferBytes: 1024 * 1024
    })
  })

  it.each(['linux', 'win32'] as const)(
    'extracts and verifies an authenticated %s tree into an exclusive staging directory',
    async (os) => {
      const value = await fixture({ os })
      const outputDirectory = join(value.root, 'fresh-parent', 'runtime')

      const result = await extractSshRelayArtifact({
        artifact: value.artifact,
        archivePath: value.archivePath,
        outputDirectory
      })
      expect(result).toEqual({
        tupleId: value.artifact.tupleId,
        contentId: value.artifact.contentId,
        runtimeRoot: await realpath(outputDirectory),
        files: value.artifact.tuple.archive.fileCount,
        expandedBytes: value.artifact.tuple.archive.expandedSize
      })
      for (const [path, bytes] of value.fileBytes) {
        expect(await readFile(join(outputDirectory, ...path.split('/')))).toEqual(bytes)
      }
      if (process.platform !== 'win32') {
        for (const entry of value.artifact.tuple.entries) {
          const metadata = await lstat(join(outputDirectory, ...entry.path.split('/')))
          expect(metadata.mode & 0o777, entry.path).toBe(entry.mode)
        }
      }
    }
  )

  it('rejects changed archive bytes before creating staging output', async () => {
    const value = await fixture({ os: 'linux' })
    await writeFile(value.archivePath, 'changed after authenticated download')
    const outputDirectory = join(value.root, 'staging', 'runtime')

    await expect(
      extractSshRelayArtifact({
        artifact: value.artifact,
        archivePath: value.archivePath,
        outputDirectory
      })
    ).rejects.toThrow(/size|sha-?256|archive/i)
    await expect(stat(outputDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['linux', 'win32'] as const)(
    'rejects an authenticated %s archive whose extracted tree disagrees with the manifest',
    async (os) => {
      const value = await fixture({ os, mismatchedPath: 'relay.js' })
      const outputDirectory = join(value.root, 'staging', 'runtime')

      await expect(
        extractSshRelayArtifact({
          artifact: value.artifact,
          archivePath: value.archivePath,
          outputDirectory
        })
      ).rejects.toThrow(/integrity|sha-?256|size|tree/i)
      await expect(stat(outputDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  it.each(['linux', 'win32'] as const)(
    'rejects an authenticated %s archive with an undeclared entry',
    async (os) => {
      const value = await fixture({ os, extraPath: 'unexpected.txt' })
      const outputDirectory = join(value.root, 'staging', 'runtime')

      await expect(
        extractSshRelayArtifact({
          artifact: value.artifact,
          archivePath: value.archivePath,
          outputDirectory
        })
      ).rejects.toThrow(/entry-count|extra|undeclared/i)
      await expect(stat(outputDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  it('rejects an authenticated TAR traversal without writing outside owned staging', async () => {
    const value = await fixture({ os: 'linux', extraPath: '../escaped.txt' })
    const outputDirectory = join(value.root, 'staging', 'runtime')
    const escapedPath = join(value.root, 'staging', 'escaped.txt')

    await expect(
      extractSshRelayArtifact({
        artifact: value.artifact,
        archivePath: value.archivePath,
        outputDirectory
      })
    ).rejects.toThrow(/extra|path|undeclared|traversal/i)
    await expect(stat(outputDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(escapedPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    ['header checksum', 'checksum', /checksum/i],
    ['nonzero file padding', 'padding', /padding/i],
    ['single-block end marker', 'end-marker', /end marker|truncated/i],
    ['aggregate overflow', 'extra-end-block', /aggregate size/i]
  ] as const)('rejects an authenticated TAR with %s corruption', async (_name, tarFault, error) => {
    const value = await fixture({ os: 'linux', tarFault })
    const outputDirectory = join(value.root, 'staging', 'runtime')

    await expect(
      extractSshRelayArtifact({
        artifact: value.artifact,
        archivePath: value.archivePath,
        outputDirectory
      })
    ).rejects.toThrow(error)
    await expect(stat(outputDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['linux', 'win32'] as const)(
    'rejects an authenticated truncated %s archive and removes owned staging',
    async (os) => {
      const value = await fixture({ os, truncated: true })
      const outputDirectory = join(value.root, 'staging', 'runtime')

      await expect(
        extractSshRelayArtifact({
          artifact: value.artifact,
          archivePath: value.archivePath,
          outputDirectory
        })
      ).rejects.toThrow(/archive|brotli|end|invalid|tar|zip/i)
      await expect(stat(outputDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  it.each([
    ['case-fold collision', { extraPath: 'RELAY.JS' }, /case-fold|duplicate/i],
    ['symbolic link', { symlinkPath: 'relay.js' }, /symbolic link|type|mode/i],
    // yauzl may reject the encrypted-size shape before exposing the flagged entry to our guard.
    ['encrypted entry', { encryptedZip: true }, /encrypted|size mismatch/i]
  ] as const)('rejects an authenticated ZIP %s', async (_name, options, expectedError) => {
    const value = await fixture({ os: 'win32', ...options })
    const outputDirectory = join(value.root, 'staging', 'runtime')

    await expect(
      extractSshRelayArtifact({
        artifact: value.artifact,
        archivePath: value.archivePath,
        outputDirectory
      })
    ).rejects.toThrow(expectedError)
    await expect(stat(outputDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('detects archive mutation after staging begins and removes its partial tree', async () => {
    const value = await fixture({ os: 'win32', largeFileBytes: 8 * 1024 * 1024 })
    const outputDirectory = join(value.root, 'staging', 'runtime')
    const rejection = expect(
      extractSshRelayArtifact({
        artifact: value.artifact,
        archivePath: value.archivePath,
        outputDirectory
      })
    ).rejects.toThrow(
      /archive|central directory|changed|invalid|unexpected (?:EOF|end of file)|zip/i
    )

    await waitForPath(outputDirectory)
    await writeFile(value.archivePath, Buffer.alloc(value.artifact.archive.size, 0x62))

    await rejection
    await expect(stat(outputDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 15_000)

  it('settles in-flight cancellation and removes only its partial staging tree', async () => {
    const value = await fixture({ os: 'win32', largeFileBytes: 8 * 1024 * 1024 })
    const outputDirectory = join(value.root, 'staging', 'runtime')
    const controller = new AbortController()
    const rejection = expect(
      extractSshRelayArtifact({
        artifact: value.artifact,
        archivePath: value.archivePath,
        outputDirectory,
        signal: controller.signal
      })
    ).rejects.toThrow(/cancel|abort/i)

    await waitForPath(outputDirectory)
    controller.abort(new Error('cancel in-flight desktop extraction'))

    await rejection
    await expect(stat(outputDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 15_000)

  it('settles pre-cancellation and preserves an existing output owner', async () => {
    const value = await fixture({ os: 'linux' })
    const controller = new AbortController()
    controller.abort(new Error('cancel desktop extraction'))
    const cancelledOutput = join(value.root, 'cancelled', 'runtime')
    await expect(
      extractSshRelayArtifact({
        artifact: value.artifact,
        archivePath: value.archivePath,
        outputDirectory: cancelledOutput,
        signal: controller.signal
      })
    ).rejects.toThrow(/cancel desktop extraction/i)
    await expect(stat(cancelledOutput)).rejects.toMatchObject({ code: 'ENOENT' })

    const existingOutput = join(value.root, 'existing')
    await writeFile(existingOutput, 'owner bytes')
    await expect(
      extractSshRelayArtifact({
        artifact: value.artifact,
        archivePath: value.archivePath,
        outputDirectory: existingOutput
      })
    ).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(existingOutput, 'utf8')).toBe('owner bytes')
  })
})
