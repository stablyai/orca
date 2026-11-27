import { defineMethod } from '../../core'
import { assertRuntimeFileMutationExpectation } from '../../../files/file-mutation-expectation'
import {
  requireLocalRuntimeFileRoute,
  resolveFileExplorerPath
} from '../../../files/file-target'
import { deleteLocalFileIfUnchanged } from '../../../../filesystem/local-file-io/local-file-delete-if-unchanged'
import type {
  FileDeleteIfUnchangedResult,
  FileWriteDiskPrecondition
} from '../../../../../shared/file-write/file-write-disk-precondition'
import type { ResolvedRuntimeFileTarget } from '../../../files/file-target'
import { FILE_REPLACE_WITH_UPLOAD_METHOD } from '../../../../../shared/file-write/file-bytes-write'
import { FILE_DELETE_IF_UNCHANGED_METHOD } from '../../../../../shared/file-write/file-write-disk-precondition'
import {
  FileCommitUpload,
  FileReplaceWithUpload,
  FileCopy,
  FileDelete,
  FileDeleteIfUnchanged,
  FileMutationOpen,
  FileRename,
  FileWrite,
  FileFormatText,
  FileWriteIfUnchanged,
  FileWriteBase64,
  FileWriteBase64Chunk
} from '../../../../../shared/rpc-contract/filesystem/files-mutation-params'

type SshMutationParams = {
  expectedExecutionHostId?: string
  expectedSshTargetId?: string
  expectedSshConnectionGeneration?: number
}

function sshMutationArguments(
  params: SshMutationParams
): [expectedGeneration?: number, expectedTargetId?: string, expectedExecutionHostId?: string] {
  if (
    params.expectedExecutionHostId === undefined &&
    params.expectedSshTargetId === undefined &&
    params.expectedSshConnectionGeneration === undefined
  ) {
    return []
  }
  return [
    params.expectedSshConnectionGeneration,
    params.expectedSshTargetId,
    params.expectedExecutionHostId
  ]
}

export const FILE_MUTATION_METHODS = [  defineMethod({
    name: 'files.formatText',
    permission: 'workspace',
    params: FileFormatText,
    handler: async (params, { runtime }) =>
      runtime.formatFileExplorerText(
        params.worktree,
        params.relativePath,
        params.content,
        ...sshMutationArguments(params)
      )
  }),
  defineMethod({
    name: 'files.write',
    permission: 'workspace',
    params: FileWrite,
    handler: async (params, { runtime }) =>
      runtime.writeFileExplorerFile(
        params.worktree,
        params.relativePath,
        params.content,
        ...sshMutationArguments(params)
      )
  }),
  defineMethod({
    name: 'files.writeIfUnchanged',
    permission: 'workspace',
    params: FileWriteIfUnchanged,
    handler: async (params, { runtime }) =>
      runtime.writeFileExplorerFile(
        params.worktree,
        params.relativePath,
        params.content,
        params.expectedSshConnectionGeneration,
        params.expectedSshTargetId,
        params.expectedExecutionHostId,
        params.diskPrecondition
      )
  }),
  defineMethod({
    name: 'files.writeBase64',
    permission: 'workspace',
    params: FileWriteBase64,
    handler: async (params, { runtime }) =>
      runtime.writeFileExplorerFileBase64(
        params.worktree,
        params.relativePath,
        params.contentBase64,
        ...sshMutationArguments(params)
      )
  }),
  defineMethod({
    name: 'files.writeBase64Chunk',
    permission: 'workspace',
    params: FileWriteBase64Chunk,
    handler: async (params, { runtime }) =>
      runtime.writeFileExplorerFileBase64Chunk(
        params.worktree,
        params.relativePath,
        params.contentBase64,
        params.append === true,
        ...sshMutationArguments(params)
      )
  }),
  defineMethod({
    name: 'files.createFile',
    permission: 'workspace',
    params: FileMutationOpen,
    handler: async (params, { runtime }) =>
      runtime.createFileExplorerFile(
        params.worktree,
        params.relativePath,
        ...sshMutationArguments(params)
      )
  }),
  defineMethod({
    name: 'files.createDir',
    permission: 'workspace',
    params: FileMutationOpen,
    handler: async (params, { runtime }) =>
      runtime.createFileExplorerDir(
        params.worktree,
        params.relativePath,
        ...sshMutationArguments(params)
      )
  }),
  defineMethod({
    name: 'files.createDirNoClobber',
    permission: 'workspace',
    params: FileMutationOpen,
    handler: async (params, { runtime }) =>
      runtime.createFileExplorerDirNoClobber(
        params.worktree,
        params.relativePath,
        ...sshMutationArguments(params)
      )
  }),
  defineMethod({
    name: 'files.commitUpload',
    permission: 'workspace',
    params: FileCommitUpload,
    handler: async (params, { runtime }) =>
      runtime.commitFileExplorerUpload(
        params.worktree,
        params.tempRelativePath,
        params.finalRelativePath,
        ...sshMutationArguments(params)
      )
  }),
  defineMethod({
    name: FILE_REPLACE_WITH_UPLOAD_METHOD,
    permission: 'workspace',
    params: FileReplaceWithUpload,
    handler: async (params, { runtime }) =>
      runtime.replaceFileExplorerFileWithUpload(
        params.worktree,
        params.tempRelativePath,
        params.finalRelativePath,
        params.bytesPrecondition,
        ...sshMutationArguments(params)
      )
  }),
  defineMethod({
    name: 'files.rename',
    permission: 'workspace',
    params: FileRename,
    handler: async (params, { runtime }) =>
      runtime.renameFileExplorerPath(
        params.worktree,
        params.oldRelativePath,
        params.newRelativePath,
        ...sshMutationArguments(params)
      )
  }),
  defineMethod({
    name: 'files.copy',
    permission: 'workspace',
    params: FileCopy,
    handler: async (params, { runtime }) =>
      runtime.copyFileExplorerPath(
        params.worktree,
        params.sourceRelativePath,
        params.destinationRelativePath,
        ...sshMutationArguments(params)
      )
  }),
  defineMethod({
    name: 'files.delete',
    permission: 'workspace',
    params: FileDelete,
    handler: async (params, { runtime }) =>
      runtime.deleteFileExplorerPath(
        params.worktree,
        params.relativePath,
        params.recursive,
        ...sshMutationArguments(params)
      )
  }),
  defineMethod({
    name: FILE_DELETE_IF_UNCHANGED_METHOD,
    permission: 'workspace',
    params: FileDeleteIfUnchanged,
    handler: async (params, { runtime }) =>
      deleteFileExplorerPathIfUnchanged(runtime, params)
  })
]

/** The guarded delete for a worktree the runtime owns; the desktop's own IPC handler guards the same way. */
async function deleteFileExplorerPathIfUnchanged(
  runtime: { resolveRuntimeFileTarget(selector: string): Promise<ResolvedRuntimeFileTarget> },
  params: {
    worktree: string
    relativePath: string
    diskPrecondition: FileWriteDiskPrecondition
    expectedExecutionHostId?: string
    expectedSshTargetId?: string
    expectedSshConnectionGeneration?: number
  }
): Promise<FileDeleteIfUnchangedResult> {
  const target = await resolveFileExplorerPath(runtime, params.worktree, params.relativePath)
  assertRuntimeFileMutationExpectation(
    target.executionHostId,
    params.expectedExecutionHostId,
    params.expectedSshTargetId,
    params.expectedSshConnectionGeneration
  )
  // A paired host's files are not this process's to open; its transport is what can hold the file.
  requireLocalRuntimeFileRoute(target)
  return deleteLocalFileIfUnchanged(target.path, params.diskPrecondition)
}
