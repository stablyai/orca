import { notShared, defineMethod, defineStreamingMethod } from '../../core'
import { runFileWatchStream } from './file-watch-stream-lifecycle'
import { FILE_MUTATION_METHODS } from './files-mutation-methods'
import { dirListingPageCache } from './files-read-dir-page'
import { FILE_STAGED_SAVE_METHODS } from './files-staged-save-methods'
import {
  assertDirListingWithinRemoteBudget,
  remoteFileContentBudget
} from './files-remote-content-budget'
import { limitQuickOpenSearchReplyBySerializedBytes } from '../../../../../shared/quick-open/quick-open-transport-budget'
import {
  FileOpen,
  FileWatch,
  WorktreeSelector
} from '../../../../../shared/rpc-contract/filesystem/files-target-params'
import { FILE_TERMINAL_ARTIFACT_METHODS } from './files-terminal-artifact-methods'
import {
  ChatImageRead,
  FilePathsExist,
  DocPreviewFileRead,
  DocPreviewFileReadChunk,
  FileListAll,
  FileOpenDiff,
  FileOpenTab,
  FilePathSearch,
  FileReadChunk,
  FileSearch,
  FileDirRead,
  FileTreePath,
  FileUnwatch,
  ResolveTerminalPath,
  ServerDirectoryBrowse
} from '../../../../../shared/rpc-contract/filesystem/files-params'
import { limitSearchResultToContentBudget } from '../../../../../shared/file-search/search-result-transport-budget'

let filesWatchSubscriptionSeq = 0

export const FILE_METHODS = [
  defineMethod({
    name: 'files.list',
    ...notShared('workspace'),
    params: WorktreeSelector,
    handler: async (params, { runtime, signal }) =>
      signal === undefined
        ? runtime.listMobileFiles(params.worktree)
        : runtime.listMobileFiles(params.worktree, { signal })
  }),
  defineMethod({
    name: 'files.searchPaths',
    ...notShared('workspace'),
    params: FilePathSearch,
    handler: async (params, { runtime, signal, clientKind, requestId }) => {
      if (params.mode !== 'quick-open') {
        return runtime.searchMobileFilePaths(params.worktree, params.query, params.limit)
      }
      const result = await runtime.searchQuickOpenFilePaths(
        params.worktree,
        params.query,
        params.limit,
        params.excludePaths,
        signal,
        {
          includeIgnored: params.includeIgnored,
          followSymlinks: params.followSymlinks,
          ...(params.allowLegacyIncludeIgnored ? { allowLegacyIncludeIgnored: true } : {})
        }
      )
      const maxContentBytes = remoteFileContentBudget(clientKind, requestId)
      return maxContentBytes === undefined
        ? result
        : limitQuickOpenSearchReplyBySerializedBytes(result, maxContentBytes)
    }
  }),
  defineMethod({
    name: 'files.open',
    ...notShared('workspace'),
    params: FileOpenTab,
    handler: async (params, { runtime }) =>
      runtime.openMobileFile(
        params.worktree,
        params.relativePath,
        params.navigation ?? 'caller',
        ...(params.line === undefined ? [] : [{ line: params.line, column: params.column }])
      )
  }),
  defineMethod({
    name: 'files.openDiff',
    ...notShared('workspace'),
    params: FileOpenDiff,
    handler: async (params, { runtime }) =>
      runtime.openMobileDiff(
        params.worktree,
        params.relativePath,
        params.staged === true,
        params.navigation ?? 'caller',
        ...(params.oldPath ? ([params.oldPath] as const) : [])
      )
  }),
  defineMethod({
    name: 'files.read',
    ...notShared('workspace'),
    params: FileOpen,
    handler: async (params, { runtime }) =>
      runtime.readMobileFile(params.worktree, params.relativePath)
  }),
  defineMethod({
    name: 'files.readDocPreview',
    ...notShared('workspace'),
    params: DocPreviewFileRead,
    handler: async (params, { runtime, clientKind, requestId }) =>
      runtime.readDocPreviewFile(
        params.worktree,
        params.relativePath,
        params.entryRelativePath,
        params.implicitRootRelativePath,
        params.authorizedRootRelativePaths,
        remoteFileContentBudget(clientKind, requestId)
      )
  }),
  defineMethod({
    name: 'files.readDocPreviewChunk',
    ...notShared('workspace'),
    params: DocPreviewFileReadChunk,
    handler: async (params, { runtime }) =>
      runtime.readDocPreviewChunk(
        params.worktree,
        params.relativePath,
        params.entryRelativePath,
        params.implicitRootRelativePath,
        params.authorizedRootRelativePaths,
        params.offset,
        params.length,
        params.media === true
      )
  }),
  defineMethod({
    name: 'files.resolveTerminalPath',
    ...notShared('workspace'),
    params: ResolveTerminalPath,
    handler: async (params, { runtime, clientId }) =>
      runtime.resolveTerminalPath(
        params.worktree,
        params.pathText,
        params.cwd ?? null,
        clientId,
        params.terminal ?? null,
        params.crossWorkspace === true,
        params.nativeChatContext ?? null
      )
  }),
  ...FILE_TERMINAL_ARTIFACT_METHODS,
  defineMethod({
    name: 'files.readPreview',
    ...notShared('workspace'),
    params: FileOpen,
    handler: async (params, { runtime, clientKind, requestId }) => {
      const budget = remoteFileContentBudget(clientKind, requestId)
      return budget === undefined
        ? runtime.readFileExplorerPreview(params.worktree, params.relativePath)
        : runtime.readFileExplorerPreview(params.worktree, params.relativePath, budget)
    }
  }),
  defineMethod({
    name: 'files.readChatImage',
    ...notShared('workspace'),
    params: ChatImageRead,
    handler: async (params, { runtime, clientKind, requestId }) =>
      runtime.readChatImagePreview(
        params.worktree,
        params.path,
        remoteFileContentBudget(clientKind, requestId)
      )
  }),
  defineMethod({
    name: 'files.readChunk',
    ...notShared('workspace'),
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
    ...notShared('workspace'),
    params: FileDirRead,
    handler: async (params, { runtime, clientKind, requestId, connectionId }) => {
      const list = () =>
        params.followSymlinks === undefined
          ? runtime.readFileExplorerDir(params.worktree, params.relativePath)
          : runtime.readFileExplorerDir(params.worktree, params.relativePath, {
              followSymlinks: params.followSymlinks
            })
      const budget = remoteFileContentBudget(clientKind, requestId)
      if (params.after === undefined && params.limit === undefined) {
        return assertDirListingWithinRemoteBudget(await list(), budget)
      }
      const page = await dirListingPageCache.readPage(connectionId, params, list)
      assertDirListingWithinRemoteBudget(page.entries, budget)
      return page
    }
  }),
  defineMethod({
    name: 'files.browseServerDir',
    ...notShared('workspace'),
    params: ServerDirectoryBrowse,
    handler: async (params, { runtime }) => runtime.browseServerDir(params.path)
  }),
  ...FILE_MUTATION_METHODS,
  ...FILE_STAGED_SAVE_METHODS,
  defineMethod({
    name: 'files.search',
    ...notShared('workspace'),
    params: FileSearch,
    handler: async (params, { runtime, clientKind, requestId, signal }) =>
      limitSearchResultToContentBudget(
        await runtime.searchRuntimeFiles(
          params.worktree,
          {
            query: params.query,
            caseSensitive: params.caseSensitive,
            wholeWord: params.wholeWord,
            useRegex: params.useRegex,
            includePattern: params.includePattern,
            excludePattern: params.excludePattern,
            maxResults: params.maxResults
          },
          { signal }
        ),
        remoteFileContentBudget(clientKind, requestId)
      )
  }),
  defineMethod({
    name: 'files.listAll',
    ...notShared('workspace'),
    params: FileListAll,
    handler: async (params, { runtime, clientKind, requestId, signal }) => {
      const maxContentBytes = remoteFileContentBudget(clientKind, requestId)
      return runtime.listRuntimeFiles(params.worktree, {
        ...(params.candidatePaths === undefined ? {} : { candidatePaths: params.candidatePaths }),
        excludePaths: params.excludePaths,
        ...(params.includeIgnored === undefined ? {} : { includeIgnored: params.includeIgnored }),
        ...(params.followSymlinks === undefined ? {} : { followSymlinks: params.followSymlinks }),
        ...(params.maxResults === undefined ? {} : { maxResults: params.maxResults }),
        ...(signal === undefined ? {} : { signal }),
        ...(maxContentBytes === undefined ? {} : { maxContentBytes })
      })
    }
  }),
  defineMethod({
    name: 'files.listMarkdownDocuments',
    ...notShared('workspace'),
    params: WorktreeSelector,
    handler: async (params, { runtime }) => runtime.listRuntimeMarkdownDocuments(params.worktree)
  }),
  defineMethod({
    name: 'files.pathsExist',
    ...notShared('workspace'),
    params: FilePathsExist,
    handler: async (params, { runtime }) =>
      runtime.pathsExistRuntimeFiles(params.worktree, params.relativePaths)
  }),
  defineMethod({
    name: 'files.stat',
    ...notShared('workspace'),
    params: FileTreePath,
    handler: async (params, { runtime }) =>
      runtime.statRuntimeFile(params.worktree, params.relativePath)
  }),
  defineStreamingMethod({
    name: 'files.watch',
    ...notShared('workspace'),
    params: FileWatch,
    handler: async (params, { runtime, connectionId, signal }, emit) => {
      const seq = ++filesWatchSubscriptionSeq
      const subscriptionId = `files-watch-${connectionId ?? 'inproc'}-${seq}`
      await runFileWatchStream({
        runtime,
        worktree: params.worktree,
        batchCadence: params.batchCadence,
        connectionId,
        signal,
        subscriptionId,
        emit
      })
    }
  }),
  defineMethod({
    name: 'files.unwatch',
    ...notShared('workspace'),
    params: FileUnwatch,
    handler: async (params, { runtime }) => {
      await runtime.cleanupSubscriptionAndWait(params.subscriptionId)
      return { unsubscribed: true }
    }
  })
]
