import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'

import type {
  SshRelayRuntimeScannedSourceTree,
  SshRelayRuntimeSourceState
} from './ssh-relay-runtime-source-scan'

export type SshRelayRuntimeSourceMetadata = {
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

export type SshRelayRuntimeSourceFileHandle = {
  stat: () => Promise<SshRelayRuntimeSourceMetadata>
  read: (
    buffer: Buffer,
    offset: number,
    length: number,
    position: number
  ) => Promise<{ bytesRead: number }>
  close: () => Promise<void>
}

export type SshRelayRuntimeSourceStreamOperations = Readonly<{
  lstat: (path: string) => Promise<SshRelayRuntimeSourceMetadata>
  openFile: (path: string) => Promise<SshRelayRuntimeSourceFileHandle>
}>

export type SshRelayRuntimeScannedSourceFile = SshRelayRuntimeScannedSourceTree['files'][number]

export const SSH_RELAY_RUNTIME_SOURCE_STREAM_OPERATIONS: SshRelayRuntimeSourceStreamOperations =
  Object.freeze({
    lstat: (path) => lstat(path, { bigint: true }),
    openFile: async (path) => {
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      return {
        stat: () => handle.stat({ bigint: true }),
        read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
        close: () => handle.close()
      }
    }
  })

export function matchesSshRelayRuntimeSourceState(
  left: SshRelayRuntimeSourceState,
  right: SshRelayRuntimeSourceMetadata
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

function assertRootSnapshot(
  tree: SshRelayRuntimeScannedSourceTree,
  metadata: SshRelayRuntimeSourceMetadata
): void {
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    !matchesSshRelayRuntimeSourceState(tree.runtimeRootState, metadata)
  ) {
    throw new Error('SSH relay runtime source root changed before or during streaming')
  }
}

function assertEntrySnapshot(
  entry: SshRelayRuntimeScannedSourceTree['directories'][number] | SshRelayRuntimeScannedSourceFile,
  metadata: SshRelayRuntimeSourceMetadata
): void {
  const correctType = entry.type === 'directory' ? metadata.isDirectory() : metadata.isFile()
  if (
    metadata.isSymbolicLink() ||
    !correctType ||
    !matchesSshRelayRuntimeSourceState(entry.state, metadata)
  ) {
    throw new Error(
      `SSH relay runtime source entry changed before or during streaming: ${entry.path}`
    )
  }
  if (process.platform !== 'win32' && Number(metadata.mode & 0o777n) !== entry.mode) {
    throw new Error(
      `SSH relay runtime source mode changed before or during streaming: ${entry.path}`
    )
  }
}

export function sshRelayRuntimeSourceParentDirectories(
  tree: SshRelayRuntimeScannedSourceTree,
  file: SshRelayRuntimeScannedSourceFile
): readonly SshRelayRuntimeScannedSourceTree['directories'][number][] {
  const directoryByPath = new Map(tree.directories.map((directory) => [directory.path, directory]))
  const parts = file.path.split('/')
  const parents: SshRelayRuntimeScannedSourceTree['directories'][number][] = []
  for (let index = 1; index < parts.length; index += 1) {
    const path = parts.slice(0, index).join('/')
    const directory = directoryByPath.get(path)
    if (!directory) {
      throw new Error(`SSH relay runtime source file has an undeclared parent: ${file.path}`)
    }
    parents.push(directory)
  }
  return parents
}

export async function assertSshRelayRuntimeSourcePathSnapshot(
  tree: SshRelayRuntimeScannedSourceTree,
  file: SshRelayRuntimeScannedSourceFile,
  parents: readonly SshRelayRuntimeScannedSourceTree['directories'][number][],
  signal: AbortSignal,
  operations: SshRelayRuntimeSourceStreamOperations
): Promise<void> {
  signal.throwIfAborted()
  assertRootSnapshot(tree, await operations.lstat(tree.runtimeRoot))
  for (const directory of parents) {
    signal.throwIfAborted()
    assertEntrySnapshot(directory, await operations.lstat(directory.localPath))
  }
  signal.throwIfAborted()
  assertEntrySnapshot(file, await operations.lstat(file.localPath))
}

export async function assertSshRelayRuntimeSourceTreeSnapshot(
  tree: SshRelayRuntimeScannedSourceTree,
  signal: AbortSignal,
  operations: SshRelayRuntimeSourceStreamOperations
): Promise<void> {
  signal.throwIfAborted()
  assertRootSnapshot(tree, await operations.lstat(tree.runtimeRoot))
  for (const entry of [...tree.directories, ...tree.files]) {
    signal.throwIfAborted()
    assertEntrySnapshot(entry, await operations.lstat(entry.localPath))
  }
}

export function assertSshRelayRuntimeOpenedFileSnapshot(
  file: SshRelayRuntimeScannedSourceFile,
  metadata: SshRelayRuntimeSourceMetadata,
  phase: 'opening' | 'streaming'
): void {
  if (!metadata.isFile() || !matchesSshRelayRuntimeSourceState(file.state, metadata)) {
    throw new Error(`SSH relay runtime source file changed while ${phase}: ${file.path}`)
  }
  if (process.platform !== 'win32' && Number(metadata.mode & 0o777n) !== file.mode) {
    throw new Error(`SSH relay runtime source mode changed while ${phase}: ${file.path}`)
  }
}
