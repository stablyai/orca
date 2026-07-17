import { createHash } from 'node:crypto'
import { lstat, open, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

import type { SshRelaySelectedArtifact } from './ssh-relay-artifact-selector'

export type SshRelayArtifactTreeVerification = {
  files: number
  expandedBytes: number
}

async function hashFile(
  path: string,
  expectedSize: number,
  signal: AbortSignal,
  chunkBytes: number
): Promise<string> {
  const digest = createHash('sha256')
  let size = 0
  const handle = await open(path, 'r')
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size !== BigInt(expectedSize)) {
      throw new Error('SSH relay extracted tree file changed before hashing')
    }
    const buffer = Buffer.allocUnsafe(Math.min(chunkBytes, Math.max(expectedSize, 1)))
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
    const after = await handle.stat({ bigint: true })
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error('SSH relay extracted tree file changed while hashing')
    }
  } finally {
    await handle.close()
  }
  if (size !== expectedSize) {
    throw new Error('SSH relay extracted tree file size disagrees with its signed size')
  }
  return `sha256:${digest.digest('hex')}`
}

export async function verifySshRelayArtifactTree({
  runtimeRoot,
  tuple,
  signal,
  chunkBytes
}: {
  runtimeRoot: string
  tuple: SshRelaySelectedArtifact['tuple']
  signal: AbortSignal
  chunkBytes: number
}): Promise<SshRelayArtifactTreeVerification> {
  const expected = new Map(tuple.entries.map((entry) => [entry.path, entry]))
  const foldedPaths = new Set<string>()
  let files = 0
  let expandedBytes = 0

  async function visit(directory: string): Promise<void> {
    signal.throwIfAborted()
    const children = await readdir(directory, { withFileTypes: true })
    for (const child of children) {
      signal.throwIfAborted()
      const absolutePath = join(directory, child.name)
      const path = relative(runtimeRoot, absolutePath).split(sep).join('/')
      const folded = path.toLowerCase()
      if (foldedPaths.has(folded)) {
        throw new Error(`SSH relay extracted tree has a case-fold collision: ${path}`)
      }
      foldedPaths.add(folded)
      const declared = expected.get(path)
      if (!declared) {
        throw new Error(`SSH relay extracted tree has an undeclared entry: ${path}`)
      }
      expected.delete(path)
      const metadata = await lstat(absolutePath)
      const actualType = metadata.isDirectory()
        ? 'directory'
        : metadata.isFile()
          ? 'file'
          : 'unsupported'
      if (actualType !== declared.type) {
        throw new Error(`SSH relay extracted tree type mismatch: ${path}`)
      }
      if (process.platform !== 'win32' && (metadata.mode & 0o777) !== declared.mode) {
        throw new Error(`SSH relay extracted tree mode mismatch: ${path}`)
      }
      if (declared.type === 'directory') {
        await visit(absolutePath)
        continue
      }
      if (metadata.size !== declared.size) {
        throw new Error(`SSH relay extracted tree size mismatch: ${path}`)
      }
      if ((await hashFile(absolutePath, declared.size, signal, chunkBytes)) !== declared.sha256) {
        throw new Error(`SSH relay extracted tree integrity mismatch: ${path}`)
      }
      files += 1
      expandedBytes += declared.size
    }
  }

  await visit(runtimeRoot)
  const missing = expected.keys().next().value as string | undefined
  if (missing) {
    throw new Error(`SSH relay extracted tree is missing a declared entry: ${missing}`)
  }
  if (files !== tuple.archive.fileCount || expandedBytes !== tuple.archive.expandedSize) {
    throw new Error('SSH relay extracted tree aggregate size or file count is inconsistent')
  }
  return { files, expandedBytes }
}
