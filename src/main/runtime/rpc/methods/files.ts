/* oxlint-disable max-lines -- Why: file RPC routing coverage stays together so the dispatcher contract for read, write, mutation, and watch methods is easy to audit. */
import { z } from 'zod'
import { defineMethod, defineStreamingMethod, type RpcAnyMethod } from '../core'
import { runFileWatchStream } from './file-watch-stream-lifecycle'

let filesWatchSubscriptionSeq = 0
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

const WorktreeSelector = z.object({
  worktree: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing worktree selector'))
})

const FilePathSearch = WorktreeSelector.extend({
  query: z.string().max(256).default(''),
  limit: z.number().int().positive().max(32).default(16)
})

const FileOpen = WorktreeSelector.extend({
  relativePath: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing relative path'))
})

const FileMutationOpen = FileOpen.extend({
  expectedExecutionHostId: z.string().min(1).optional(),
  expectedSshTargetId: z.string().min(1).optional(),
  expectedSshConnectionGeneration: z.number().int().nonnegative().optional()
})

const ResolveTerminalPath = WorktreeSelector.extend({
  pathText: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing path text')),
  terminal: z
    .unknown()
    .transform((v) => (typeof v === 'string' && v.length > 0 ? v : null))
    .nullable()
    .optional(),
  cwd: z
    .unknown()
    .transform((v) => (typeof v === 'string' && v.length > 0 ? v : null))
    .nullable()
    .optional()
})

const TerminalArtifactFile = WorktreeSelector.extend({
  grantId: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing terminal artifact grant')),
  absolutePath: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing terminal artifact path'))
})

const TerminalArtifactFileWrite = TerminalArtifactFile.extend({
  content: z
    .unknown()
    .refine((v): v is string => typeof v === 'string', { message: 'Missing file content' })
})

const FileOpenDiff = FileOpen.extend({
  staged: z.boolean().optional()
})

const FileTreePath = WorktreeSelector.extend({
  relativePath: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string())
})

const ServerDirectoryBrowse = z.object({
  path: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string())
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

const FileReadChunk = FileOpen.extend({
  offset: z.number().int().nonnegative(),
  length: z
    .number()
    .int()
    .positive()
    .max(512 * 1024)
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

const FileSearch = WorktreeSelector.extend({
  query: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing search query')),
  caseSensitive: z.boolean().optional(),
  wholeWord: z.boolean().optional(),
  useRegex: z.boolean().optional(),
  includePattern: z.string().optional(),
  excludePattern: z.string().optional(),
  maxResults: z.number().int().positive().optional()
})

const FileListAll = WorktreeSelector.extend({
  excludePaths: z.array(z.string()).optional()
})

const FileUnwatch = z.object({
  subscriptionId: z
    .unknown()
    .transform((value) => (typeof value === 'string' && value.length > 0 ? value : ''))
    .pipe(z.string().min(1, 'Missing subscriptionId'))
})

export const FILE_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'files.list',
    params: WorktreeSelector,
    handler: async (params, { runtime }) => runtime.listMobileFiles(params.worktree)
  }),
  defineMethod({
    name: 'files.searchPaths',
    params: FilePathSearch,
    handler: async (params, { runtime }) =>
      runtime.searchMobileFilePaths(params.worktree, params.query, params.limit)
  }),
  defineMethod({
    name: 'files.open',
    params: FileOpen,
    handler: async (params, { runtime }) =>
      runtime.openMobileFile(params.worktree, params.relativePath)
  }),
  defineMethod({
    name: 'files.openDiff',
    params: FileOpenDiff,
    handler: async (params, { runtime }) =>
      runtime.openMobileDiff(params.worktree, params.relativePath, params.staged === true)
  }),
  defineMethod({
    name: 'files.read',
    params: FileOpen,
    handler: async (params, { runtime }) =>
      runtime.readMobileFile(params.worktree, params.relativePath)
  }),
  defineMethod({
    name: 'files.resolveTerminalPath',
    params: ResolveTerminalPath,
    handler: async (params, { runtime, clientId }) =>
      runtime.resolveTerminalPath(
        params.worktree,
        params.pathText,
        params.cwd ?? null,
        clientId,
        params.terminal ?? null
      )
  }),
  defineMethod({
    name: 'files.readTerminalArtifact',
    params: TerminalArtifactFile,
    handler: async (params, { runtime, clientId }) =>
      runtime.readTerminalArtifactFile(
        params.worktree,
        params.grantId,
        params.absolutePath,
        clientId
      )
  }),
  defineMethod({
    name: 'files.readTerminalArtifactPreview',
    params: TerminalArtifactFile,
    handler: async (params, { runtime, clientId }) =>
      runtime.readTerminalArtifactPreview(
        params.worktree,
        params.grantId,
        params.absolutePath,
        clientId
      )
  }),
  defineMethod({
    name: 'files.writeTerminalArtifact',
    params: TerminalArtifactFileWrite,
    handler: async (params, { runtime, clientId }) =>
      runtime.writeTerminalArtifactFile(
        params.worktree,
        params.grantId,
        params.absolutePath,
        params.content,
        clientId
      )
  }),
  defineMethod({
    name: 'files.readPreview',
    params: FileOpen,
    handler: async (params, { runtime }) =>
      runtime.readFileExplorerPreview(params.worktree, params.relativePath)
  }),
  defineMethod({
    name: 'files.readChunk',
    params: FileReadChunk,
    handler: async (params, { runtime }) =>
      runtime.readFileExplorerChunk(
        params.worktree,
        params.relativePath,
        params.offset,
        params.length
      )
  }),
  defineMethod({
    name: 'files.readDir',
    params: FileTreePath,
    handler: async (params, { runtime }) =>
      runtime.readFileExplorerDir(params.worktree, params.relativePath)
  }),
  defineMethod({
    name: 'files.browseServerDir',
    params: ServerDirectoryBrowse,
    handler: async (params, { runtime }) => runtime.browseServerDir(params.path)
  }),
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
  }),
  defineMethod({
    name: 'files.search',
    params: FileSearch,
    handler: async (params, { runtime }) =>
      runtime.searchRuntimeFiles(params.worktree, {
        query: params.query,
        caseSensitive: params.caseSensitive,
        wholeWord: params.wholeWord,
        useRegex: params.useRegex,
        includePattern: params.includePattern,
        excludePattern: params.excludePattern,
        maxResults: params.maxResults
      })
  }),
  defineMethod({
    name: 'files.listAll',
    params: FileListAll,
    handler: async (params, { runtime }) =>
      runtime.listRuntimeFiles(params.worktree, { excludePaths: params.excludePaths })
  }),
  defineMethod({
    name: 'files.listMarkdownDocuments',
    params: WorktreeSelector,
    handler: async (params, { runtime }) => runtime.listRuntimeMarkdownDocuments(params.worktree)
  }),
  defineMethod({
    name: 'files.stat',
    params: FileTreePath,
    handler: async (params, { runtime }) =>
      runtime.statRuntimeFile(params.worktree, params.relativePath)
  }),
  defineStreamingMethod({
    name: 'files.watch',
    params: WorktreeSelector,
    handler: async (params, { runtime, connectionId, signal }, emit) => {
      const seq = ++filesWatchSubscriptionSeq
      const subscriptionId = `files-watch-${connectionId ?? 'inproc'}-${seq}`
      await runFileWatchStream({
        runtime,
        worktree: params.worktree,
        connectionId,
        signal,
        subscriptionId,
        emit
      })
    }
  }),
  defineMethod({
    name: 'files.unwatch',
    params: FileUnwatch,
    handler: async (params, { runtime }) => {
      await runtime.cleanupSubscriptionAndWait(params.subscriptionId)
      return { unsubscribed: true }
    }
  })
]
