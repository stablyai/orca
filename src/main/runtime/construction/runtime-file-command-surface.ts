import type { RuntimeFileSearch } from '../files/search/file-search'
import type { RuntimeTerminalArtifacts } from '../terminal/artifacts/terminal-artifacts'
import type { RuntimeFileAccess } from '../files/file-access'
import type { RuntimeFileReads } from '../files/file-reads'
import type { RuntimeFileMutations } from '../files/file-mutations'
import type { RuntimeStagedFileSaves } from '../files/staged-file-save-commands'
import type { RuntimeFileWatches } from '../files/watch/file-watches'
import type { RuntimeTerminalPathResolver } from '../terminal/terminal-path-resolver'

export type RuntimeFileCommandSurface = Pick<
  RuntimeFileSearch,
  | 'listMobileFiles'
  | 'searchMobileFilePaths'
  | 'searchQuickOpenFilePaths'
  | 'searchRuntimeFiles'
  | 'listRuntimeFiles'
> &
  Pick<
    RuntimeFileAccess,
    | 'openMobileFile'
    | 'openMobileDiff'
    | 'listRuntimeMarkdownDocuments'
    | 'pathsExistRuntimeFiles'
    | 'statRuntimeFile'
  > &
  Pick<
    RuntimeFileReads,
    | 'readMobileFile'
    | 'readFileExplorerPreview'
    | 'readChatImagePreview'
    | 'readFileExplorerChunk'
    | 'readDocPreviewFile'
    | 'readDocPreviewChunk'
  > &
  Pick<RuntimeTerminalPathResolver, 'resolveTerminalPath'> &
  Pick<
    RuntimeTerminalArtifacts,
    | 'readTerminalArtifactFile'
    | 'readTerminalArtifactPreview'
    | 'statTerminalArtifact'
    | 'readTerminalArtifactChunk'
    | 'writeTerminalArtifactFile'
    | 'revokeTerminalFileGrantsForClient'
  > &
  Pick<RuntimeFileWatches, 'readFileExplorerDir' | 'watchFileExplorer'> &
  Pick<
    RuntimeFileMutations,
    | 'writeFileExplorerFile'
    | 'formatFileExplorerText'
    | 'writeFileExplorerFileBase64'
    | 'writeFileExplorerFileBase64Chunk'
    | 'createFileExplorerFile'
    | 'createFileExplorerDir'
    | 'createFileExplorerDirNoClobber'
    | 'commitFileExplorerUpload'
    | 'replaceFileExplorerFileWithUpload'
    | 'renameFileExplorerPath'
    | 'copyFileExplorerPath'
    | 'deleteFileExplorerPath'
  > & { readonly stagedFileSaves: RuntimeStagedFileSaves }

export function installRuntimeFileCommandSurface(
  target: RuntimeFileCommandSurface,
  fileSearch: RuntimeFileSearch,
  terminalArtifacts: RuntimeTerminalArtifacts,
  fileAccess: RuntimeFileAccess,
  fileReads: RuntimeFileReads,
  fileMutations: RuntimeFileMutations,
  stagedFileSaveCommands: RuntimeStagedFileSaves,
  fileWatches: RuntimeFileWatches,
  terminalPaths: RuntimeTerminalPathResolver
): void {
  Object.assign(target, {
    listMobileFiles: fileSearch.listMobileFiles.bind(fileSearch),
    searchMobileFilePaths: fileSearch.searchMobileFilePaths.bind(fileSearch),
    searchQuickOpenFilePaths: fileSearch.searchQuickOpenFilePaths.bind(fileSearch),
    openMobileFile: fileAccess.openMobileFile.bind(fileAccess),
    openMobileDiff: fileAccess.openMobileDiff.bind(fileAccess),
    readMobileFile: fileReads.readMobileFile.bind(fileReads),
    resolveTerminalPath: terminalPaths.resolveTerminalPath.bind(terminalPaths),
    readTerminalArtifactFile: terminalArtifacts.readTerminalArtifactFile.bind(terminalArtifacts),
    readTerminalArtifactPreview:
      terminalArtifacts.readTerminalArtifactPreview.bind(terminalArtifacts),
    statTerminalArtifact: terminalArtifacts.statTerminalArtifact.bind(terminalArtifacts),
    readTerminalArtifactChunk: terminalArtifacts.readTerminalArtifactChunk.bind(terminalArtifacts),
    writeTerminalArtifactFile: terminalArtifacts.writeTerminalArtifactFile.bind(terminalArtifacts),
    revokeTerminalFileGrantsForClient:
      terminalArtifacts.revokeTerminalFileGrantsForClient.bind(terminalArtifacts),
    readFileExplorerDir: fileWatches.readFileExplorerDir.bind(fileWatches),
    watchFileExplorer: fileWatches.watchFileExplorer.bind(fileWatches),
    readFileExplorerPreview: fileReads.readFileExplorerPreview.bind(fileReads),
    readChatImagePreview: fileReads.readChatImagePreview.bind(fileReads),
    readFileExplorerChunk: fileReads.readFileExplorerChunk.bind(fileReads),
    readDocPreviewFile: fileReads.readDocPreviewFile.bind(fileReads),
    readDocPreviewChunk: fileReads.readDocPreviewChunk.bind(fileReads),
    writeFileExplorerFile: fileMutations.writeFileExplorerFile.bind(fileMutations),
    formatFileExplorerText: fileMutations.formatFileExplorerText.bind(fileMutations),
    writeFileExplorerFileBase64: fileMutations.writeFileExplorerFileBase64.bind(fileMutations),
    writeFileExplorerFileBase64Chunk:
      fileMutations.writeFileExplorerFileBase64Chunk.bind(fileMutations),
    createFileExplorerFile: fileMutations.createFileExplorerFile.bind(fileMutations),
    createFileExplorerDir: fileMutations.createFileExplorerDir.bind(fileMutations),
    createFileExplorerDirNoClobber:
      fileMutations.createFileExplorerDirNoClobber.bind(fileMutations),
    commitFileExplorerUpload: fileMutations.commitFileExplorerUpload.bind(fileMutations),
    replaceFileExplorerFileWithUpload:
      fileMutations.replaceFileExplorerFileWithUpload.bind(fileMutations),
    renameFileExplorerPath: fileMutations.renameFileExplorerPath.bind(fileMutations),
    copyFileExplorerPath: fileMutations.copyFileExplorerPath.bind(fileMutations),
    deleteFileExplorerPath: fileMutations.deleteFileExplorerPath.bind(fileMutations),
    searchRuntimeFiles: fileSearch.searchRuntimeFiles.bind(fileSearch),
    listRuntimeFiles: fileSearch.listRuntimeFiles.bind(fileSearch),
    listRuntimeMarkdownDocuments: fileAccess.listRuntimeMarkdownDocuments.bind(fileAccess),
    pathsExistRuntimeFiles: fileAccess.pathsExistRuntimeFiles.bind(fileAccess),
    statRuntimeFile: fileAccess.statRuntimeFile.bind(fileAccess),
    stagedFileSaves: stagedFileSaveCommands
  } satisfies RuntimeFileCommandSurface)
}
