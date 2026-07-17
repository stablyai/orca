import { createHash } from 'node:crypto'
import { lstat, open, readdir, rm, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'

import {
  parseSshRelayArtifactCacheEntryProof,
  SSH_RELAY_ARTIFACT_CACHE_ENTRY_PROOF_MAX_BYTES,
  SSH_RELAY_ARTIFACT_CACHE_ENTRY_PROOF_NAME
} from './ssh-relay-artifact-cache-entry-proof'
import type { SshRelaySelectedArtifact } from './ssh-relay-artifact-selector'
import { verifySshRelayArtifactTree } from './ssh-relay-artifact-tree-verification'

const CHUNK_BYTES = 64 * 1024

type FileState = {
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}

function sameFileState(left: FileState, right: FileState): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

async function writeComplete(handle: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, null)
    if (bytesWritten <= 0) {
      throw new Error('SSH relay artifact cache archive copy could not be persisted')
    }
    offset += bytesWritten
  }
}

async function hashExactRegularFile({
  path,
  expectedSize,
  expectedSha256,
  signal
}: {
  path: string
  expectedSize: number
  expectedSha256: string
  signal: AbortSignal
}): Promise<void> {
  signal.throwIfAborted()
  const before = await lstat(path, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.size !== BigInt(expectedSize)) {
    throw new Error('SSH relay artifact cache archive is not the exact signed regular file')
  }
  const hash = createHash('sha256')
  const handle = await open(path, 'r')
  let size = 0
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || !sameFileState(before, opened)) {
      throw new Error('SSH relay artifact cache archive changed before hashing')
    }
    const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, Math.max(expectedSize, 1)))
    while (size < expectedSize) {
      signal.throwIfAborted()
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, expectedSize - size),
        size
      )
      if (bytesRead === 0) {
        break
      }
      size += bytesRead
      hash.update(buffer.subarray(0, bytesRead))
    }
    const after = await handle.stat({ bigint: true })
    if (!sameFileState(opened, after)) {
      throw new Error('SSH relay artifact cache archive changed while hashing')
    }
  } finally {
    await handle.close()
  }
  const after = await lstat(path, { bigint: true })
  if (!sameFileState(before, after) || size !== expectedSize) {
    throw new Error('SSH relay artifact cache archive changed while hashing')
  }
  const sha256 = `sha256:${hash.digest('hex')}`
  if (sha256 !== expectedSha256) {
    throw new Error('SSH relay artifact cache archive SHA-256 disagrees with the signed manifest')
  }
}

export async function copyVerifiedSshRelayArtifactCacheArchive({
  sourcePath,
  destinationPath,
  artifact,
  signal
}: {
  sourcePath: string
  destinationPath: string
  artifact: SshRelaySelectedArtifact
  signal: AbortSignal
}): Promise<void> {
  signal.throwIfAborted()
  const before = await lstat(sourcePath, { bigint: true })
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size !== BigInt(artifact.archive.size)
  ) {
    throw new Error('SSH relay artifact cache source must be the exact signed regular archive')
  }
  const source = await open(sourcePath, 'r')
  let destination: FileHandle
  try {
    destination = await open(destinationPath, 'wx', 0o600)
  } catch (error) {
    await source.close().catch(() => {})
    throw error
  }
  const hash = createHash('sha256')
  let size = 0
  let complete = false
  try {
    const opened = await source.stat({ bigint: true })
    if (!opened.isFile() || !sameFileState(before, opened)) {
      throw new Error('SSH relay artifact cache source changed before copying')
    }
    const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, Math.max(artifact.archive.size, 1)))
    while (size < artifact.archive.size) {
      signal.throwIfAborted()
      const { bytesRead } = await source.read(
        buffer,
        0,
        Math.min(buffer.length, artifact.archive.size - size),
        size
      )
      if (bytesRead === 0) {
        break
      }
      const bytes = buffer.subarray(0, bytesRead)
      hash.update(bytes)
      await writeComplete(destination, bytes)
      size += bytesRead
    }
    const readComplete = await source.stat({ bigint: true })
    if (!sameFileState(opened, readComplete)) {
      throw new Error('SSH relay artifact cache source changed while copying')
    }
    await destination.sync()
    const written = await destination.stat({ bigint: true })
    if (!written.isFile() || written.size !== BigInt(size)) {
      throw new Error('SSH relay artifact cache archive copy is incomplete')
    }
    const sha256 = `sha256:${hash.digest('hex')}`
    if (size !== artifact.archive.size || sha256 !== artifact.archive.sha256) {
      throw new Error('SSH relay artifact cache source archive disagrees with the signed manifest')
    }
    signal.throwIfAborted()
    complete = true
  } finally {
    await Promise.all([source.close().catch(() => {}), destination.close().catch(() => {})])
    if (!complete) {
      await rm(destinationPath, { force: true }).catch(() => {})
    }
  }
  const after = await lstat(sourcePath, { bigint: true })
  if (!sameFileState(before, after)) {
    await rm(destinationPath, { force: true }).catch(() => {})
    throw new Error('SSH relay artifact cache source changed while copying')
  }
}

async function readExactProof(path: string): Promise<Buffer> {
  const before = await lstat(path, { bigint: true })
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > BigInt(SSH_RELAY_ARTIFACT_CACHE_ENTRY_PROOF_MAX_BYTES)
  ) {
    throw new Error('SSH relay artifact cache proof is not a bounded regular file')
  }
  const handle = await open(path, 'r')
  try {
    const opened = await handle.stat({ bigint: true })
    if (!sameFileState(before, opened)) {
      throw new Error('SSH relay artifact cache proof changed before reading')
    }
    const bytes = Buffer.alloc(Number(opened.size))
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (bytesRead === 0) {
        break
      }
      offset += bytesRead
    }
    const after = await handle.stat({ bigint: true })
    if (offset !== bytes.length || !sameFileState(opened, after)) {
      throw new Error('SSH relay artifact cache proof changed while reading')
    }
    return bytes
  } finally {
    await handle.close()
  }
}

export type SshRelayArtifactCacheEntry = {
  contentId: SshRelaySelectedArtifact['contentId']
  tupleId: SshRelaySelectedArtifact['tupleId']
  entryPath: string
  archivePath: string
  runtimeRoot: string
  proofPath: string
  files: number
  expandedBytes: number
}

export async function verifySshRelayArtifactCacheEntry({
  entryPath,
  artifact,
  signal
}: {
  entryPath: string
  artifact: SshRelaySelectedArtifact
  signal: AbortSignal
}): Promise<SshRelayArtifactCacheEntry> {
  signal.throwIfAborted()
  const root = await lstat(entryPath)
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error('SSH relay artifact cache entry is not an immutable directory')
  }
  const expectedMembers = [
    artifact.archive.name,
    SSH_RELAY_ARTIFACT_CACHE_ENTRY_PROOF_NAME,
    'runtime'
  ].sort()
  const members = (await readdir(entryPath)).sort()
  if (JSON.stringify(members) !== JSON.stringify(expectedMembers)) {
    throw new Error('SSH relay artifact cache entry has missing or unexpected members')
  }

  const archivePath = join(entryPath, artifact.archive.name)
  const proofPath = join(entryPath, SSH_RELAY_ARTIFACT_CACHE_ENTRY_PROOF_NAME)
  const runtimeRoot = join(entryPath, 'runtime')
  const proof = parseSshRelayArtifactCacheEntryProof(await readExactProof(proofPath), artifact)
  await hashExactRegularFile({
    path: archivePath,
    expectedSize: artifact.archive.size,
    expectedSha256: artifact.archive.sha256,
    signal
  })
  const runtime = await lstat(runtimeRoot)
  if (!runtime.isDirectory() || runtime.isSymbolicLink()) {
    throw new Error('SSH relay artifact cache runtime is not an immutable directory')
  }
  const tree = await verifySshRelayArtifactTree({
    runtimeRoot,
    tuple: artifact.tuple,
    signal,
    chunkBytes: CHUNK_BYTES
  })
  if (tree.files !== proof.runtime.files || tree.expandedBytes !== proof.runtime.expandedBytes) {
    throw new Error('SSH relay artifact cache proof disagrees with the complete runtime tree')
  }
  signal.throwIfAborted()
  return {
    contentId: artifact.contentId,
    tupleId: artifact.tupleId,
    entryPath,
    archivePath,
    runtimeRoot,
    proofPath,
    ...tree
  }
}

export const SSH_RELAY_ARTIFACT_CACHE_ENTRY_VERIFICATION_LIMITS = Object.freeze({
  chunkBytes: CHUNK_BYTES,
  proofMaxBytes: SSH_RELAY_ARTIFACT_CACHE_ENTRY_PROOF_MAX_BYTES
})
