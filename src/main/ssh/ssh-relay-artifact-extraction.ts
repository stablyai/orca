import { createHash } from 'node:crypto'
import { lstat, mkdir, open, realpath, rm } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'

import type { SshRelaySelectedArtifact } from './ssh-relay-artifact-selector'
import { extractSshRelayTarBrotli } from './ssh-relay-artifact-tar-extraction'
import { inspectSshRelayTarBrotli } from './ssh-relay-artifact-tar-inspection'
import { verifySshRelayArtifactTree } from './ssh-relay-artifact-tree-verification'
import { extractSshRelayZip, inspectSshRelayZip } from './ssh-relay-artifact-zip-extraction'

const EXTRACTION_TIMEOUT_MS = 2 * 60_000
const CHUNK_BYTES = 64 * 1024
const MAXIMUM_INCREMENTAL_MEMORY_BYTES = 80 * 1024 * 1024
const MAXIMUM_WRITE_BUFFER_BYTES = 1024 * 1024

type ArchiveState = {
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}

function sameArchiveState(left: ArchiveState, right: ArchiveState): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

async function describeArchive(
  archivePath: string,
  expectedSize: number,
  signal: AbortSignal
): Promise<{ sha256: string; state: ArchiveState }> {
  signal.throwIfAborted()
  const before = await lstat(archivePath, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.size !== BigInt(expectedSize)) {
    throw new Error('SSH relay extraction input must be the exact signed regular archive file')
  }
  const digest = createHash('sha256')
  let size = 0
  const handle = await open(archivePath, 'r')
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || !sameArchiveState(before, opened)) {
      throw new Error('SSH relay extraction input changed before hashing')
    }
    // Why: one reusable buffer prevents consecutive archive passes from retaining full-file slabs.
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
      digest.update(buffer.subarray(0, bytesRead))
    }
    const readComplete = await handle.stat({ bigint: true })
    if (!sameArchiveState(opened, readComplete)) {
      throw new Error('SSH relay extraction input changed while hashing')
    }
  } finally {
    await handle.close()
  }
  const after = await lstat(archivePath, { bigint: true })
  if (!sameArchiveState(before, after) || size !== expectedSize) {
    throw new Error('SSH relay extraction input changed while hashing')
  }
  return { sha256: `sha256:${digest.digest('hex')}`, state: after }
}

function assertSelectedArtifact(artifact: SshRelaySelectedArtifact): void {
  // Why: only the recursively frozen signature-verified selector result may cross this boundary.
  if (
    artifact.tupleId !== artifact.tuple.tupleId ||
    artifact.contentId !== artifact.tuple.contentId ||
    artifact.archive.name !== artifact.tuple.archive.name ||
    artifact.archive.size !== artifact.tuple.archive.size ||
    artifact.archive.sha256 !== artifact.tuple.archive.sha256
  ) {
    throw new Error('SSH relay selected artifact identity is inconsistent')
  }
}

export type SshRelayArtifactExtractionResult = {
  tupleId: SshRelaySelectedArtifact['tupleId']
  contentId: SshRelaySelectedArtifact['contentId']
  runtimeRoot: string
  files: number
  expandedBytes: number
}

export async function extractSshRelayArtifact({
  artifact,
  archivePath,
  outputDirectory,
  signal
}: {
  artifact: SshRelaySelectedArtifact
  archivePath: string
  outputDirectory: string
  signal?: AbortSignal
}): Promise<SshRelayArtifactExtractionResult> {
  const effectiveSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(EXTRACTION_TIMEOUT_MS)])
    : AbortSignal.timeout(EXTRACTION_TIMEOUT_MS)
  effectiveSignal.throwIfAborted()
  assertSelectedArtifact(artifact)
  const absoluteArchive = resolve(archivePath)
  const absoluteOutput = resolve(outputDirectory)
  const before = await describeArchive(absoluteArchive, artifact.archive.size, effectiveSignal)
  if (before.sha256 !== artifact.archive.sha256) {
    throw new Error('SSH relay extraction input SHA-256 disagrees with the signed manifest')
  }

  const outputParent = dirname(absoluteOutput)
  await mkdir(outputParent, { recursive: true, mode: 0o700 })
  const physicalParent = await realpath(outputParent)
  const physicalOutput = resolve(physicalParent, basename(absoluteOutput))
  let outputCreated = false
  try {
    // Why: no cache publisher or concurrent extractor may observe a shared partial runtime tree.
    await mkdir(physicalOutput, { mode: 0o700 })
    outputCreated = true
    if (artifact.tuple.os === 'win32') {
      await inspectSshRelayZip({
        archivePath: absoluteArchive,
        tuple: artifact.tuple,
        signal: effectiveSignal
      })
      await extractSshRelayZip({
        archivePath: absoluteArchive,
        outputDirectory: physicalOutput,
        tuple: artifact.tuple,
        signal: effectiveSignal
      })
    } else {
      await inspectSshRelayTarBrotli({
        archivePath: absoluteArchive,
        tuple: artifact.tuple,
        signal: effectiveSignal,
        chunkBytes: CHUNK_BYTES
      })
      await extractSshRelayTarBrotli({
        archivePath: absoluteArchive,
        outputDirectory: physicalOutput,
        tuple: artifact.tuple,
        signal: effectiveSignal,
        chunkBytes: CHUNK_BYTES
      })
    }
    const tree = await verifySshRelayArtifactTree({
      runtimeRoot: physicalOutput,
      tuple: artifact.tuple,
      signal: effectiveSignal,
      chunkBytes: CHUNK_BYTES
    })
    const after = await describeArchive(absoluteArchive, artifact.archive.size, effectiveSignal)
    if (!sameArchiveState(before.state, after.state) || before.sha256 !== after.sha256) {
      throw new Error('SSH relay extraction input changed during extraction')
    }
    effectiveSignal.throwIfAborted()
    return {
      tupleId: artifact.tupleId,
      contentId: artifact.contentId,
      runtimeRoot: physicalOutput,
      ...tree
    }
  } catch (error) {
    if (outputCreated) {
      // Why: only a fully verified tree may remain eligible for later atomic cache publication.
      await rm(physicalOutput, { recursive: true, force: true })
    }
    throw error
  }
}

export const SSH_RELAY_ARTIFACT_EXTRACTION_LIMITS = Object.freeze({
  timeoutMs: EXTRACTION_TIMEOUT_MS,
  chunkBytes: CHUNK_BYTES,
  maximumIncrementalMemoryBytes: MAXIMUM_INCREMENTAL_MEMORY_BYTES,
  maximumWriteBufferBytes: MAXIMUM_WRITE_BUFFER_BYTES
})
