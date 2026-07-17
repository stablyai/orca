import { createHash } from 'node:crypto'
import { lstat, open, opendir } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  SshRelayRuntimeSourceDirectory,
  SshRelayRuntimeSourceFile,
  SshRelayRuntimeSourceTree
} from './ssh-relay-runtime-source-tree'

const CHUNK_BYTES = 64 * 1024
const MEASUREMENT_TIMEOUT_MS = 2 * 60_000
const MAXIMUM_INCREMENTAL_MEMORY_BYTES = 80 * 1024 * 1024

type SourceMetadata = {
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
  mode: bigint
  isFile: () => boolean
  isDirectory: () => boolean
  isSymbolicLink: () => boolean
}

type SourceDirectoryHandle = {
  read: () => Promise<{ name: string } | null>
  close: () => Promise<void>
}

type SourceFileHandle = {
  stat: () => Promise<SourceMetadata>
  read: (
    buffer: Buffer,
    offset: number,
    length: number,
    position: number
  ) => Promise<{ bytesRead: number }>
  close: () => Promise<void>
}

export type SshRelayRuntimeSourceScanOperations = Readonly<{
  lstat: (path: string) => Promise<SourceMetadata>
  openDirectory: (path: string) => Promise<SourceDirectoryHandle>
  openFile: (path: string) => Promise<SourceFileHandle>
}>

export type SshRelayRuntimeSourceState = Readonly<{
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}>

export type SshRelayRuntimeScannedSourceTree = Readonly<
  Omit<SshRelayRuntimeSourceTree, 'directories' | 'files'> & {
    runtimeRootState: SshRelayRuntimeSourceState
    directories: readonly Readonly<
      SshRelayRuntimeSourceDirectory & { state: SshRelayRuntimeSourceState }
    >[]
    files: readonly Readonly<SshRelayRuntimeSourceFile & { state: SshRelayRuntimeSourceState }>[]
  }
>

const DEFAULT_OPERATIONS: SshRelayRuntimeSourceScanOperations = Object.freeze({
  lstat: (path) => lstat(path, { bigint: true }),
  openDirectory: (path) => opendir(path),
  openFile: async (path) => {
    const handle = await open(path, 'r')
    return {
      stat: () => handle.stat({ bigint: true }),
      read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
      close: () => handle.close()
    }
  }
})

function sourceState(metadata: SourceMetadata): SshRelayRuntimeSourceState {
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs
  })
}

function sameState(left: SshRelayRuntimeSourceState, right: SourceMetadata): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

function assertExactType(
  metadata: SourceMetadata,
  expected: SshRelayRuntimeSourceDirectory | SshRelayRuntimeSourceFile,
  path: string
): void {
  if (metadata.isSymbolicLink()) {
    throw new Error(`SSH relay runtime source contains a linked entry: ${path}`)
  }
  const matches = expected.type === 'directory' ? metadata.isDirectory() : metadata.isFile()
  if (!matches) {
    throw new Error(`SSH relay runtime source has a special or mismatched entry type: ${path}`)
  }
  if (process.platform !== 'win32' && Number(metadata.mode & 0o777n) !== expected.mode) {
    throw new Error(`SSH relay runtime source mode changed: ${path}`)
  }
  if (expected.type === 'file' && metadata.size !== BigInt(expected.size)) {
    throw new Error(`SSH relay runtime source file size changed: ${path}`)
  }
}

async function hashFile(
  file: SshRelayRuntimeSourceFile,
  expectedState: SshRelayRuntimeSourceState,
  buffer: Buffer,
  signal: AbortSignal,
  operations: SshRelayRuntimeSourceScanOperations
): Promise<void> {
  signal.throwIfAborted()
  const before = await operations.lstat(file.localPath)
  assertExactType(before, file, file.path)
  if (!sameState(expectedState, before)) {
    throw new Error(`SSH relay runtime source file changed before hashing: ${file.path}`)
  }
  signal.throwIfAborted()
  const handle = await operations.openFile(file.localPath)
  const digest = createHash('sha256')
  let bytes = 0
  try {
    signal.throwIfAborted()
    const opened = await handle.stat()
    if (!opened.isFile() || !sameState(expectedState, opened)) {
      throw new Error(`SSH relay runtime source file changed while opening: ${file.path}`)
    }
    while (bytes < file.size) {
      signal.throwIfAborted()
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, file.size - bytes),
        bytes
      )
      if (bytesRead <= 0) {
        break
      }
      bytes += bytesRead
      digest.update(buffer.subarray(0, bytesRead))
    }
    signal.throwIfAborted()
    const after = await handle.stat()
    if (!sameState(expectedState, after)) {
      throw new Error(`SSH relay runtime source file changed while hashing: ${file.path}`)
    }
  } finally {
    await handle.close()
  }
  signal.throwIfAborted()
  const afterClose = await operations.lstat(file.localPath)
  if (!sameState(expectedState, afterClose) || bytes !== file.size) {
    throw new Error(`SSH relay runtime source file changed while hashing: ${file.path}`)
  }
  if (`sha256:${digest.digest('hex')}` !== file.sha256) {
    throw new Error(`SSH relay runtime source file integrity changed: ${file.path}`)
  }
}

export async function scanSshRelayRuntimeSourceTree(
  tree: SshRelayRuntimeSourceTree,
  signal: AbortSignal,
  overrides: Partial<SshRelayRuntimeSourceScanOperations> = {}
): Promise<SshRelayRuntimeScannedSourceTree> {
  const operations = { ...DEFAULT_OPERATIONS, ...overrides }
  signal.throwIfAborted()
  await tree.assertLeaseOwned()
  signal.throwIfAborted()

  const expected = new Map<string, SshRelayRuntimeSourceDirectory | SshRelayRuntimeSourceFile>()
  const expectedFolded = new Set<string>()
  for (const entry of [...tree.directories, ...tree.files]) {
    if (entry.localPath !== join(tree.runtimeRoot, ...entry.path.split('/'))) {
      throw new Error(`SSH relay runtime source descriptor path is inconsistent: ${entry.path}`)
    }
    const folded = entry.path.toLowerCase()
    if (expected.has(entry.path) || expectedFolded.has(folded)) {
      throw new Error(`SSH relay runtime source descriptor has a path collision: ${entry.path}`)
    }
    expected.set(entry.path, entry)
    expectedFolded.add(folded)
  }

  const rootMetadata = await operations.lstat(tree.runtimeRoot)
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error('SSH relay runtime source root must be a real directory')
  }
  const runtimeRootState = sourceState(rootMetadata)
  const states = new Map<string, SshRelayRuntimeSourceState>()
  const seen = new Set<string>()
  const seenFolded = new Set<string>()
  const pending = [{ path: '', localPath: tree.runtimeRoot }]
  while (pending.length > 0) {
    signal.throwIfAborted()
    const directory = pending.pop()!
    const handle = await operations.openDirectory(directory.localPath)
    try {
      while (true) {
        signal.throwIfAborted()
        const child = await handle.read()
        if (!child) {
          break
        }
        const path = directory.path ? `${directory.path}/${child.name}` : child.name
        const folded = path.toLowerCase()
        if (seen.has(path) || seenFolded.has(folded)) {
          throw new Error(`SSH relay runtime source has a path collision: ${path}`)
        }
        seen.add(path)
        seenFolded.add(folded)
        if (seen.size > expected.size) {
          throw new Error(`SSH relay runtime source has an extra entry: ${path}`)
        }
        const declared = expected.get(path)
        if (!declared) {
          if (expectedFolded.has(folded)) {
            throw new Error(`SSH relay runtime source has a path collision: ${path}`)
          }
          throw new Error(`SSH relay runtime source has an undeclared entry: ${path}`)
        }
        signal.throwIfAborted()
        const metadata = await operations.lstat(declared.localPath)
        assertExactType(metadata, declared, path)
        states.set(path, sourceState(metadata))
        if (declared.type === 'directory') {
          pending.push({ path, localPath: declared.localPath })
        }
      }
    } finally {
      await handle.close()
    }
  }
  for (const path of expected.keys()) {
    if (!seen.has(path)) {
      throw new Error(`SSH relay runtime source is missing a declared entry: ${path}`)
    }
  }

  const buffer = Buffer.allocUnsafe(CHUNK_BYTES)
  for (const file of tree.files) {
    await hashFile(file, states.get(file.path)!, buffer, signal, operations)
  }
  signal.throwIfAborted()
  const rootAfter = await operations.lstat(tree.runtimeRoot)
  if (!rootAfter.isDirectory() || !sameState(runtimeRootState, rootAfter)) {
    throw new Error('SSH relay runtime source root changed during pre-scan')
  }
  for (const entry of [...tree.directories, ...tree.files]) {
    signal.throwIfAborted()
    const after = await operations.lstat(entry.localPath)
    assertExactType(after, entry, entry.path)
    if (!sameState(states.get(entry.path)!, after)) {
      throw new Error(`SSH relay runtime source entry changed during pre-scan: ${entry.path}`)
    }
  }
  signal.throwIfAborted()
  await tree.assertLeaseOwned()
  signal.throwIfAborted()

  return Object.freeze({
    ...tree,
    runtimeRootState,
    directories: Object.freeze(
      tree.directories.map((entry) => Object.freeze({ ...entry, state: states.get(entry.path)! }))
    ),
    files: Object.freeze(
      tree.files.map((entry) => Object.freeze({ ...entry, state: states.get(entry.path)! }))
    )
  })
}

export const SSH_RELAY_RUNTIME_SOURCE_SCAN_LIMITS = Object.freeze({
  chunkBytes: CHUNK_BYTES,
  measurementTimeoutMs: MEASUREMENT_TIMEOUT_MS,
  maximumIncrementalMemoryBytes: MAXIMUM_INCREMENTAL_MEMORY_BYTES
})
