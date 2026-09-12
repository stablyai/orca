import { defineMethod } from '../core'
import {
  FileCommitUpload,
  FileCopy,
  FileDelete,
  FileMutationOpen,
  FileRename,
  FileWrite,
  FileWriteBase64,
  FileWriteBase64Chunk
} from '../../../../shared/rpc-contract/files-mutation-params'

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

export const FILE_MUTATION_METHODS = [
  defineMethod({
    name: 'files.write',
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
    name: 'files.writeBase64',
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
    name: 'files.rename',
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
    params: FileDelete,
    handler: async (params, { runtime }) =>
      runtime.deleteFileExplorerPath(
        params.worktree,
        params.relativePath,
        params.recursive,
        ...sshMutationArguments(params)
      )
  })
]
