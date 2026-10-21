/**
 * Where a phone's Markdown tab file is read and written: this machine's disk for a local workspace,
 * and for a paired server's (`runtime:<env>`) the same `files.read` / `files.writeIfUnchanged` calls
 * the desktop editor makes, so that server reads its own disk and does the compare-and-write itself.
 * A raw `ssh:` host is refused on both, by the route every local file command takes.
 */
import { isBinaryBuffer } from '../../shared/binary-buffer'
import { parseExecutionHostId } from '../../shared/execution-host'
import {
  compareDiskWritePrecondition,
  diskConflictFromReadFailure,
  FILE_WRITE_DISK_PRECONDITION_RUNTIME_CAPABILITY,
  FILE_WRITE_IF_UNCHANGED_METHOD,
  parseFileWriteResult,
  type FileWriteDiskConflict,
  type FileWriteDiskPrecondition,
  type FileWriteResult
} from '../../shared/file-write-disk-precondition'
import { utf8ByteLength } from '../../shared/mobile-markdown-document'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'
import { assertFileMutationOwnershipCapability } from '../../shared/file-mutation-ownership'
import type { PersistedOpenFile } from '../../shared/workspace-session-state-types'
import { readLocalRuntimeFilePrefix } from './files/file-reads'
import {
  requireLocalRuntimeFileRoute,
  requireRuntimeFileProvider,
  type ResolvedRuntimeFileTarget,
  type RuntimeLocalFileHost
} from './files/file-target'
import type {
  MarkdownDiskFile,
  MarkdownFileIo,
  MarkdownTabDiskHost
} from './markdown-tab-disk-documents'
import { OrchestrationError } from './orchestration/orchestration-error'
import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'

type EnvironmentCall = (
  environmentId: string,
  method: string,
  params: unknown,
  expectedPairingRevision?: number
) => Promise<unknown>

export type MarkdownTabDiskRuntime = RuntimeLocalFileHost &
  Pick<MarkdownTabDiskHost, 'getWorkspaceSessionForWorktree'> & {
    resolveRuntimeFileTarget(selector: string): Promise<ResolvedRuntimeFileTarget>
    callEnvironment: EnvironmentCall
    /** The server's current pairing, so every call of one save reaches the server it probed. */
    environmentPairingRevision(environmentId: string): number | undefined
  }

export function createMarkdownTabDiskHost(runtime: MarkdownTabDiskRuntime): MarkdownTabDiskHost {
  const routeOf = async (worktreeId: string, file: MarkdownFileAddress) => {
    // Why: a file outside the workspace on an SSH host is that host's; no process here serves it.
    if (file.externalSshTargetId) {
      throw new SshHostNotServedError(file.externalSshTargetId)
    }
    const target = await runtime.resolveRuntimeFileTarget(`id:${worktreeId}`)
    const host = parseExecutionHostId(target.executionHostId)
    if (host?.kind === 'runtime') {
      return { environmentId: host.environmentId, target }
    }
    requireLocalRuntimeFileRoute(target)
    return { environmentId: null, target }
  }
  // `pairingRevision` is the pairing a save captured before its first call; a phone read leaves it unset.
  const fileIo = (pairingRevision: number | undefined): MarkdownFileIo => ({
    readFile: async (worktreeId, file, maxBytes) => {
      const { environmentId } = await routeOf(worktreeId, file)
      if (environmentId) {
        return readFileOnEnvironment(
          runtime.callEnvironment,
          environmentId,
          worktreeId,
          file,
          pairingRevision
        )
      }
      const { bytes, size } = await readLocalRuntimeFilePrefix(
        file.filePath,
        runtime.requireStore(),
        maxBytes
      )
      if (isBinaryBuffer(bytes)) {
        throw new Error('binary_file')
      }
      return { content: bytes.toString('utf8'), byteLength: size }
    },
    writeFileIfUnchanged: async (worktreeId, file, content, precondition) => {
      const { environmentId, target } = await routeOf(worktreeId, file)
      if (environmentId) {
        return writeFileOnEnvironment(
          runtime.callEnvironment,
          environmentId,
          pairingRevision,
          worktreeId,
          file,
          content,
          precondition
        )
      }
      return requireRuntimeFileProvider(target, runtime).writeFileWithDiskPrecondition(
        file.filePath,
        content,
        precondition
      )
    }
  })
  return {
    getWorkspaceSessionForWorktree: (worktreeId) =>
      runtime.getWorkspaceSessionForWorktree(worktreeId),
    readFile: fileIo(undefined).readFile,
    forSave: async (worktreeId, file) => {
      const { environmentId } = await routeOf(worktreeId, file)
      return fileIo(environmentId ? pairingRevisionOf(runtime, environmentId) : undefined)
    }
  }
}

function pairingRevisionOf(
  runtime: Pick<MarkdownTabDiskRuntime, 'environmentPairingRevision'>,
  environmentId: string
): number | undefined {
  try {
    return runtime.environmentPairingRevision(environmentId)
  } catch (error) {
    throw new RemoteRuntimeClientError(
      'remote_runtime_unavailable',
      error instanceof Error ? error.message : String(error)
    )
  }
}

type MarkdownFileAddress = Pick<PersistedOpenFile, 'relativePath' | 'externalSshTargetId'>

/** The server's answer passes through; losing it is `remote_runtime_unavailable`, never a disk verdict. */
async function callEnvironment(
  call: EnvironmentCall,
  environmentId: string,
  method: string,
  params: unknown,
  expectedPairingRevision?: number
): Promise<unknown> {
  try {
    return await call(environmentId, method, params, expectedPairingRevision)
  } catch (error) {
    if (error instanceof OrchestrationError && error.code !== 'server_required') {
      throw error
    }
    throw new RemoteRuntimeClientError(
      'remote_runtime_unavailable',
      error instanceof Error ? error.message : String(error)
    )
  }
}

async function readFileOnEnvironment(
  call: EnvironmentCall,
  environmentId: string,
  worktreeId: string,
  file: MarkdownFileAddress,
  pairingRevision: number | undefined
): Promise<MarkdownDiskFile> {
  const address = { worktree: `id:${worktreeId}`, relativePath: file.relativePath }
  const read = await callEnvironment(call, environmentId, 'files.read', address, pairingRevision)
  if (!isRecord(read) || typeof read.content !== 'string') {
    throw new Error('invalid_runtime_response')
  }
  const cut = utf8ByteLength(read.content)
  if (read.truncated !== true) {
    return { content: read.content, byteLength: cut }
  }
  // Why: a truncated `files.read` reports where it cut, not the file size the phone labels.
  const stat = await callEnvironment(call, environmentId, 'files.stat', address, pairingRevision)
  const size = isRecord(stat) && typeof stat.size === 'number' ? stat.size : 0
  return { content: read.content, byteLength: Math.max(size, cut + 1) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * The desktop editor's guarded remote save (`writeRemoteFileIfUnchanged`): a server that advertises
 * the disk check compares at write time; an older one is compared from here before a plain write.
 * Every call is pinned to the pairing the save captured before its first read, so a re-pair never
 * receives the write.
 */
async function writeFileOnEnvironment(
  call: EnvironmentCall,
  environmentId: string,
  pairingRevision: number | undefined,
  worktreeId: string,
  file: MarkdownFileAddress,
  content: string,
  diskPrecondition: FileWriteDiskPrecondition
): Promise<FileWriteResult> {
  const pinned = (method: string, params: unknown): Promise<unknown> =>
    callEnvironment(call, environmentId, method, params, pairingRevision)
  const status = await pinned('status.get', undefined)
  const capabilities =
    isRecord(status) && Array.isArray(status.capabilities) ? status.capabilities : []
  assertFileMutationOwnershipCapability({ capabilities })
  const params = {
    worktree: `id:${worktreeId}`,
    relativePath: file.relativePath,
    content,
    // Why `local`: the server writes only a workspace it runs itself, so the write never hops on.
    expectedExecutionHostId: 'local'
  }
  if (capabilities.includes(FILE_WRITE_DISK_PRECONDITION_RUNTIME_CAPABILITY)) {
    return parseFileWriteResult(
      await pinned(FILE_WRITE_IF_UNCHANGED_METHOD, { ...params, diskPrecondition })
    )
  }
  const diskConflict = await diskConflictOnServer(pinned, params, diskPrecondition)
  if (diskConflict) {
    return { ok: false, diskConflict }
  }
  return parseFileWriteResult(await pinned('files.write', params))
}

/** For a server that would write unguarded: a read that cannot prove the disk fails the save. */
async function diskConflictOnServer(
  pinned: (method: string, params: unknown) => Promise<unknown>,
  address: { worktree: string; relativePath: string },
  precondition: FileWriteDiskPrecondition
): Promise<FileWriteDiskConflict | null> {
  let read: unknown
  try {
    read = await pinned('files.read', {
      worktree: address.worktree,
      relativePath: address.relativePath
    })
  } catch (error) {
    return diskConflictFromReadFailure(precondition, error)
  }
  if (!isRecord(read) || typeof read.content !== 'string' || read.truncated === true) {
    return compareDiskWritePrecondition(precondition, undefined)
  }
  return compareDiskWritePrecondition(precondition, read.content)
}
