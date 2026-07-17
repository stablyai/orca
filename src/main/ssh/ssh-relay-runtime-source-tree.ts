import { join } from 'node:path'

import type { SshRelayArtifactReadyAcquisition } from './ssh-relay-artifact-acquisition'
import type {
  SshRelayDigest,
  SshRelayRuntimeFileRole,
  SshRelayRuntimeTupleId
} from './ssh-relay-runtime-identity'

export type SshRelayRuntimeSourceDirectory = Readonly<{
  path: string
  localPath: string
  type: 'directory'
  mode: 0o755
}>

export type SshRelayRuntimeSourceFile = Readonly<{
  path: string
  localPath: string
  type: 'file'
  role: SshRelayRuntimeFileRole
  size: number
  mode: 0o644 | 0o755
  sha256: SshRelayDigest
}>

export type SshRelayRuntimeSourceTree = Readonly<{
  tupleId: SshRelayRuntimeTupleId
  contentId: SshRelayDigest
  releaseTag: string
  os: 'linux' | 'darwin' | 'win32'
  architecture: 'x64' | 'arm64'
  runtimeRoot: string
  directories: readonly SshRelayRuntimeSourceDirectory[]
  files: readonly SshRelayRuntimeSourceFile[]
  fileCount: number
  expandedBytes: number
  assertLeaseOwned: () => Promise<void>
}>

function compareAscii(left: { path: string }, right: { path: string }): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0
}

export function createSshRelayRuntimeSourceTree(
  acquisition: SshRelayArtifactReadyAcquisition
): SshRelayRuntimeSourceTree {
  if (!acquisition || acquisition.kind !== 'ready') {
    throw new Error('SSH relay runtime source tree requires a ready artifact acquisition')
  }
  const { artifact, entry, lease } = acquisition
  if (
    artifact.tupleId !== artifact.tuple.tupleId ||
    artifact.contentId !== artifact.tuple.contentId ||
    entry.tupleId !== artifact.tupleId ||
    entry.contentId !== artifact.contentId
  ) {
    throw new Error('SSH relay runtime source tree has inconsistent artifact identity')
  }
  if (entry.runtimeRoot !== join(entry.entryPath, 'runtime')) {
    throw new Error('SSH relay runtime source tree has a noncanonical cache runtime root')
  }

  const directories: SshRelayRuntimeSourceDirectory[] = []
  const files: SshRelayRuntimeSourceFile[] = []
  let expandedBytes = 0
  for (const manifestEntry of artifact.tuple.entries) {
    const localPath = join(entry.runtimeRoot, ...manifestEntry.path.split('/'))
    if (manifestEntry.type === 'directory') {
      directories.push(
        Object.freeze({
          path: manifestEntry.path,
          localPath,
          type: manifestEntry.type,
          mode: manifestEntry.mode
        })
      )
      continue
    }
    expandedBytes += manifestEntry.size
    files.push(
      Object.freeze({
        path: manifestEntry.path,
        localPath,
        type: manifestEntry.type,
        role: manifestEntry.role,
        size: manifestEntry.size,
        mode: manifestEntry.mode,
        sha256: manifestEntry.sha256
      })
    )
  }
  if (files.length !== artifact.archive.fileCount || entry.files !== artifact.archive.fileCount) {
    throw new Error('SSH relay runtime source tree file count disagrees with the signed artifact')
  }
  if (
    expandedBytes !== artifact.archive.expandedSize ||
    entry.expandedBytes !== artifact.archive.expandedSize
  ) {
    throw new Error(
      'SSH relay runtime source tree expanded byte count disagrees with the signed artifact'
    )
  }

  directories.sort(compareAscii)
  files.sort(compareAscii)
  // Why: transports borrow the live cache lease; only their orchestration owner may release it
  // after transfer and cleanup have both settled.
  const assertLeaseOwned = (): Promise<void> => lease.assertOwned()
  return Object.freeze({
    tupleId: artifact.tupleId,
    contentId: artifact.contentId,
    releaseTag: artifact.releaseTag,
    os: artifact.tuple.os,
    architecture: artifact.tuple.architecture,
    runtimeRoot: entry.runtimeRoot,
    directories: Object.freeze(directories),
    files: Object.freeze(files),
    fileCount: files.length,
    expandedBytes,
    assertLeaseOwned
  })
}
