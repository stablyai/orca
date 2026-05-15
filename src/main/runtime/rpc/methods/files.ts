import { z } from 'zod'
import { defineMethod, defineStreamingMethod, type RpcAnyMethod } from '../core'
import { createFileWatchEventBatcher } from './file-watch-event-batcher'

let filesWatchSubscriptionSeq = 0

const WorktreeSelector = z.object({
  worktree: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing worktree selector'))
})

const FileOpen = WorktreeSelector.extend({
  relativePath: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing relative path'))
})

const FileTreePath = WorktreeSelector.extend({
  relativePath: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string())
})

const FileWrite = FileOpen.extend({
  content: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string())
})

const FileWriteBase64 = FileOpen.extend({
  contentBase64: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string())
})

const FileWriteBase64Chunk = FileWriteBase64.extend({
  append: z.boolean().optional()
})

const FileRename = WorktreeSelector.extend({
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
  tempRelativePath: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing temporary path')),
  finalRelativePath: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing final path'))
})

const FileDelete = FileOpen.extend({
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
    name: 'files.open',
    params: FileOpen,
    handler: async (params, { runtime }) =>
      runtime.openMobileFile(params.worktree, params.relativePath)
  }),
  defineMethod({
    name: 'files.read',
    params: FileOpen,
    handler: async (params, { runtime }) =>
      runtime.readMobileFile(params.worktree, params.relativePath)
  }),
  defineMethod({
    name: 'files.readPreview',
    params: FileOpen,
    handler: async (params, { runtime }) =>
      runtime.readFileExplorerPreview(params.worktree, params.relativePath)
  }),
  defineMethod({
    name: 'files.readDir',
    params: FileTreePath,
    handler: async (params, { runtime }) =>
      runtime.readFileExplorerDir(params.worktree, params.relativePath)
  }),
  defineMethod({
    name: 'files.write',
    params: FileWrite,
    handler: async (params, { runtime }) =>
      runtime.writeFileExplorerFile(params.worktree, params.relativePath, params.content)
  }),
  defineMethod({
    name: 'files.writeBase64',
    params: FileWriteBase64,
    handler: async (params, { runtime }) =>
      runtime.writeFileExplorerFileBase64(
        params.worktree,
        params.relativePath,
        params.contentBase64
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
        params.append === true
      )
  }),
  defineMethod({
    name: 'files.createFile',
    params: FileOpen,
    handler: async (params, { runtime }) =>
      runtime.createFileExplorerFile(params.worktree, params.relativePath)
  }),
  defineMethod({
    name: 'files.createDir',
    params: FileOpen,
    handler: async (params, { runtime }) =>
      runtime.createFileExplorerDir(params.worktree, params.relativePath)
  }),
  defineMethod({
    name: 'files.createDirNoClobber',
    params: FileOpen,
    handler: async (params, { runtime }) =>
      runtime.createFileExplorerDirNoClobber(params.worktree, params.relativePath)
  }),
  defineMethod({
    name: 'files.commitUpload',
    params: FileCommitUpload,
    handler: async (params, { runtime }) =>
      runtime.commitFileExplorerUpload(
        params.worktree,
        params.tempRelativePath,
        params.finalRelativePath
      )
  }),
  defineMethod({
    name: 'files.rename',
    params: FileRename,
    handler: async (params, { runtime }) =>
      runtime.renameFileExplorerPath(
        params.worktree,
        params.oldRelativePath,
        params.newRelativePath
      )
  }),
  defineMethod({
    name: 'files.copy',
    params: FileCopy,
    handler: async (params, { runtime }) =>
      runtime.copyFileExplorerPath(
        params.worktree,
        params.sourceRelativePath,
        params.destinationRelativePath
      )
  }),
  defineMethod({
    name: 'files.delete',
    params: FileDelete,
    handler: async (params, { runtime }) =>
      runtime.deleteFileExplorerPath(params.worktree, params.relativePath, params.recursive)
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
      if (signal?.aborted) {
        return
      }
      await new Promise<void>((resolve, reject) => {
        let settled = false
        let unwatch: (() => void) | null = null
        const eventBatcher = createFileWatchEventBatcher(params.worktree, emit)
        const finish = (): void => {
          if (settled) {
            return
          }
          settled = true
          signal?.removeEventListener('abort', handleAbort)
          resolve()
        }
        const cleanup = (): void => {
          eventBatcher.flush()
          eventBatcher.dispose()
          unwatch?.()
          emit({ type: 'end' })
          finish()
        }
        const handleAbort = (): void => {
          if (unwatch) {
            cleanup()
          } else {
            finish()
          }
        }
        signal?.addEventListener('abort', handleAbort, { once: true })
        void runtime
          .watchFileExplorer(params.worktree, (events) => {
            eventBatcher.push(events)
          })
          .then((nextUnwatch) => {
            if (signal?.aborted || settled) {
              // Why: the connection can close while watch setup is still
              // resolving. Tear down the late watcher immediately instead of
              // registering cleanup on a connection that was already reaped.
              nextUnwatch()
              return
            }
            unwatch = nextUnwatch
            runtime.registerSubscriptionCleanup(subscriptionId, cleanup, connectionId)
            emit({ type: 'ready', subscriptionId })
          })
          .catch((error) => {
            if (!settled) {
              signal?.removeEventListener('abort', handleAbort)
              reject(error)
            }
          })
      })
    }
  }),
  defineMethod({
    name: 'files.unwatch',
    params: FileUnwatch,
    handler: async (params, { runtime }) => {
      runtime.cleanupSubscription(params.subscriptionId)
      return { unsubscribed: true }
    }
  })
]
