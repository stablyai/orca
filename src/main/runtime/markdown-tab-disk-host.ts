/** Local workspaces use local disk; runtime environments use their server's file RPCs/compare-write.
 * Raw SSH routes remain unsupported instead of falling back to client paths. */
import { isBinaryBuffer } from '../../shared/binary-buffer'
import { parseExecutionHostId } from '../../shared/execution-host'
import {
  compareDiskWritePrecondition,
  diskConflictFromReadFailure,
  FILE_WRITE_DISK_PRECONDITION_RUNTIME_CAPABILITY,
  FILE_WRITE_IF_UNCHANGED_METHOD,
  hostEnforcesPrecondition,
  FILE_WRITE_UNCHANGED,
  parseFileWriteResult,
  type FileWriteDiskComparison,
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
    /** Pin every save call to the pairing captured by its initial probe. */
    environmentPairingRevision(environmentId: string): number | undefined
  }

type MarkdownFileRoute =
  | { environmentId: string; pairingRevision: number | undefined }
  | { environmentId: null; target: ResolvedRuntimeFileTarget }

export function createMarkdownTabDiskHost(runtime: MarkdownTabDiskRuntime): MarkdownTabDiskHost {
  const routeOf = async (
    worktreeId: string,
    file: MarkdownFileAddress
  ): Promise<MarkdownFileRoute> => {
    if (file.externalSshTargetId) {
      throw new SshHostNotServedError(file.externalSshTargetId)
    }
    const target = await runtime.resolveRuntimeFileTarget(`id:${worktreeId}`)
    const host = parseExecutionHostId(target.executionHostId)
    if (host?.kind === 'runtime') {
      return { environmentId: host.environmentId, pairingRevision: undefined }
    }
    requireLocalRuntimeFileRoute(target)
    return { environmentId: null, target }
  }
  const fileIo = (
    routeFor: (worktreeId: string, file: MarkdownFileAddress) => Promise<MarkdownFileRoute>
  ): MarkdownFileIo => ({
    readFile: async (worktreeId, file, maxBytes) => {
      const route = await routeFor(worktreeId, file)
      if (route.environmentId !== null) {
        return readFileOnEnvironment(
          runtime.callEnvironment,
          route.environmentId,
          worktreeId,
          file,
          route.pairingRevision
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
      const route = await routeFor(worktreeId, file)
      if (route.environmentId !== null) {
        return writeFileOnEnvironment(
          runtime.callEnvironment,
          route.environmentId,
          route.pairingRevision,
          worktreeId,
          file,
          content,
          precondition
        )
      }
      return requireRuntimeFileProvider(route.target, runtime).writeFileWithDiskPrecondition(
        file.filePath,
        content,
        precondition
      )
    }
  })
  return {
    getWorkspaceSessionForWorktree: (worktreeId) =>
      runtime.getWorkspaceSessionForWorktree(worktreeId),
    readFile: fileIo(routeOf).readFile,
    forSave: async (worktreeId, file) => {
      const found = await routeOf(worktreeId, file)
      // A host move mid-save must not redirect the pinned write.
      const route: MarkdownFileRoute =
        found.environmentId !== null
          ? { ...found, pairingRevision: pairingRevisionOf(runtime, found.environmentId) }
          : found
      return fileIo(async () => route)
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
  // Truncated reads report their cut; stat separately for the phone's full-size label.
  const stat = await callEnvironment(call, environmentId, 'files.stat', address, pairingRevision)
  const size = isRecord(stat) && typeof stat.size === 'number' ? stat.size : 0
  return { content: read.content, byteLength: Math.max(size, cut + 1) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Use server compare-write when advertised; older servers require a client-side precomparison.
 * Pin every call to the initial pairing so re-pairing cannot redirect the write. */
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
    // The server must write locally, never forward the mutation onward.
    expectedExecutionHostId: 'local'
  }
  if (hostEnforcesPrecondition(capabilities, diskPrecondition)) {
    return parseFileWriteResult(
      await pinned(FILE_WRITE_IF_UNCHANGED_METHOD, { ...params, diskPrecondition })
    )
  }
  const diskConflict = await diskConflictOnServer(pinned, params, diskPrecondition)
  if (diskConflict === 'identical') {
    return FILE_WRITE_UNCHANGED
  }
  if (diskConflict) {
    return { ok: false, diskConflict }
  }
  return parseFileWriteResult(
    capabilities.includes(FILE_WRITE_DISK_PRECONDITION_RUNTIME_CAPABILITY)
      ? await pinned(FILE_WRITE_IF_UNCHANGED_METHOD, { ...params, diskPrecondition })
      : await pinned('files.write', params)
  )
}

async function diskConflictOnServer(
  pinned: (method: string, params: unknown) => Promise<unknown>,
  write: { worktree: string; relativePath: string; content: string },
  precondition: FileWriteDiskPrecondition
): Promise<FileWriteDiskComparison> {
  let read: unknown
  try {
    read = await pinned('files.read', {
      worktree: write.worktree,
      relativePath: write.relativePath
    })
  } catch (error) {
    return diskConflictFromReadFailure(precondition, error)
  }
  if (!isRecord(read) || typeof read.content !== 'string' || read.truncated === true) {
    return compareDiskWritePrecondition(precondition, undefined, write.content)
  }
  return compareDiskWritePrecondition(precondition, read.content, write.content)
}
