import { z } from 'zod'
import { defineMethod, type RpcAnyMethod } from '../core'
import { FileOpen, WorktreeSelector } from './files-target-schemas'

const RUNTIME_FILE_BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

function isValidRuntimeFileBase64(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length % 4 !== 1 && RUNTIME_FILE_BASE64_PATTERN.test(value)
  )
}

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

const FileMutationOpen = FileOpen.extend({
  expectedExecutionHostId: z.string().min(1).optional(),
  expectedSshTargetId: z.string().min(1).optional(),
  expectedSshConnectionGeneration: z.number().int().nonnegative().optional()
})

// Why: write content must be a real string. Coercing a missing/non-string value
// to '' silently truncated the target file to empty instead of erroring. An
// explicit '' is still accepted (writing an empty file is legitimate).
const FileWrite = FileMutationOpen.extend({
  content: z
    .unknown()
    .refine((v): v is string => typeof v === 'string', { message: 'Missing file content' })
})

const FileWriteBase64 = FileMutationOpen.extend({
  contentBase64: z
    .unknown()
    .refine((v): v is string => typeof v === 'string', { message: 'Missing file content' })
    // Why: Buffer.from(..., 'base64') accepts malformed input by dropping
    // invalid bytes, which can silently create empty or corrupt uploaded files.
    .refine(isValidRuntimeFileBase64, 'File content must be base64')
})

const FileWriteBase64Chunk = FileWriteBase64.extend({
  append: z.boolean().optional()
})

const FileRename = WorktreeSelector.extend({
  expectedExecutionHostId: z.string().min(1).optional(),
  expectedSshTargetId: z.string().min(1).optional(),
  expectedSshConnectionGeneration: z.number().int().nonnegative().optional(),
  oldRelativePath: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing source path')),
  newRelativePath: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing destination path'))
})

const FileCopy = WorktreeSelector.extend({
  expectedExecutionHostId: z.string().min(1).optional(),
  expectedSshTargetId: z.string().min(1).optional(),
  expectedSshConnectionGeneration: z.number().int().nonnegative().optional(),
  sourceRelativePath: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing source path')),
  destinationRelativePath: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing destination path'))
})

const FileCommitUpload = WorktreeSelector.extend({
  expectedExecutionHostId: z.string().min(1).optional(),
  expectedSshTargetId: z.string().min(1).optional(),
  expectedSshConnectionGeneration: z.number().int().nonnegative().optional(),
  tempRelativePath: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing temporary path')),
  finalRelativePath: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing final path'))
})

const FileDelete = FileMutationOpen.extend({
  recursive: z.boolean().optional()
})

export const FILE_MUTATION_METHODS: RpcAnyMethod[] = [
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
