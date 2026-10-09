import { defineMethod, defineStreamingMethod } from '../core'
import { runFileWatchStream } from './file-watch-stream-lifecycle'
import { FILE_MUTATION_METHODS } from './files-mutation-methods'
import {
  assertDirListingWithinRemoteBudget,
  remoteFileContentBudget
} from './files-remote-content-budget'
import { limitQuickOpenSearchReplyBySerializedBytes } from '../../../../shared/quick-open-transport-budget'
import { FileOpen, WorktreeSelector } from './files-target-schemas'
import { FILE_TERMINAL_ARTIFACT_METHODS } from './files-terminal-artifact-methods'
import {
  FilePathsExist,
  DocPreviewFileRead,
  FileListAll,
  FileOpenDiff,
  FileOpenTab,
  FilePathSearch,
  FileReadChunk,
  FileSearch,
  FileTreePath,
  FileUnwatch,
  ResolveTerminalPath,
  ServerDirectoryBrowse
} from '../../../../shared/rpc-contract/files-params'

let filesWatchSubscriptionSeq = 0

export const FILE_METHODS = [
  defineMethod({
    name: 'files.list',
    permission: 'workspace',
    params: WorktreeSelector,
    handler: async (params, { runtime, signal }) =>
      signal === undefined
        ? runtime.listMobileFiles(params.worktree)
        : runtime.listMobileFiles(params.worktree, { signal })
  }),
  defineMethod({
    name: 'files.searchPaths',
    permission: 'workspace',
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
    permission: 'workspace',
    params: FileOpenTab,
    handler: async (params, { runtime }) =>
      runtime.openMobileFile(params.worktree, params.relativePath, params.navigation)
  }),
  defineMethod({
    name: 'files.openDiff',
    permission: 'workspace',
    params: FileOpenDiff,
    handler: async (params, { runtime }) =>
      runtime.openMobileDiff(
        params.worktree,
        params.relativePath,
        params.staged === true,
        params.navigation
      )
  }),
  defineMethod({
    name: 'files.read',
    permission: 'workspace',
    params: FileOpen,
    handler: async (params, { runtime }) =>
      runtime.readMobileFile(params.worktree, params.relativePath)
  }),
  defineMethod({
    name: 'files.readDocPreview',
    permission: 'workspace',
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
    name: 'files.resolveTerminalPath',
    permission: 'workspace',
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
    permission: 'workspace',
    params: FileOpen,
    handler: async (params, { runtime, clientKind, requestId }) => {
      const budget = remoteFileContentBudget(clientKind, requestId)
      return budget === undefined
        ? runtime.readFileExplorerPreview(params.worktree, params.relativePath)
        : runtime.readFileExplorerPreview(params.worktree, params.relativePath, budget)
    }
  }),
  defineMethod({
    name: 'files.readChunk',
    permission: 'workspace',
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
    permission: 'workspace',
    params: FileTreePath,
    handler: async (params, { runtime, clientKind, requestId }) =>
      assertDirListingWithinRemoteBudget(
        params.followSymlinks === undefined
          ? await runtime.readFileExplorerDir(params.worktree, params.relativePath)
          : await runtime.readFileExplorerDir(params.worktree, params.relativePath, {
              followSymlinks: params.followSymlinks
            }),
        remoteFileContentBudget(clientKind, requestId)
      )
  }),
  defineMethod({
    name: 'files.browseServerDir',
    permission: 'workspace',
    params: ServerDirectoryBrowse,
    handler: async (params, { runtime }) => runtime.browseServerDir(params.path)
  }),
  ...FILE_MUTATION_METHODS,
  defineMethod({
    name: 'files.search',
    permission: 'workspace',
    params: FileSearch,
    handler: async (params, { runtime, signal }) =>
      runtime.searchRuntimeFiles(
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
      )
  }),
  defineMethod({
    name: 'files.listAll',
    permission: 'workspace',
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
    permission: 'workspace',
    params: WorktreeSelector,
    handler: async (params, { runtime }) => runtime.listRuntimeMarkdownDocuments(params.worktree)
  }),
  defineMethod({
    name: 'files.pathsExist',
    permission: 'workspace',
    params: FilePathsExist,
    handler: async (params, { runtime }) =>
      runtime.pathsExistRuntimeFiles(params.worktree, params.relativePaths)
  }),
  defineMethod({
    name: 'files.stat',
    permission: 'workspace',
    params: FileTreePath,
    handler: async (params, { runtime }) =>
      runtime.statRuntimeFile(params.worktree, params.relativePath)
  }),
  defineStreamingMethod({
    name: 'files.watch',
    permission: 'workspace',
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
    permission: 'workspace',
    params: FileUnwatch,
    handler: async (params, { runtime }) => {
      await runtime.cleanupSubscriptionAndWait(params.subscriptionId)
      return { unsubscribed: true }
    }
  })
]
