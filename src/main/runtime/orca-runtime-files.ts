import { RuntimeFileSearch } from './files/search/file-search'
import { RuntimeTerminalArtifacts } from './terminal/artifacts/terminal-artifacts'
import { RuntimeFileAccess } from './files/file-access'
import { RuntimeFileReads } from './files/file-reads'
import { RuntimeFileMutations } from './files/file-mutations'
import { RuntimeFileWatches } from './files/watch/file-watches'
import { RuntimeStagedFileSaves } from './files/staged-file-save-commands'
import { RuntimeTerminalPathResolver } from './terminal/terminal-path-resolver'
import type { RuntimeFileCommandHost } from './files/file-command-host'

export class RuntimeFileCommands {
  private readonly search: RuntimeFileSearch
  private readonly artifacts: RuntimeTerminalArtifacts
  private readonly access: RuntimeFileAccess
  private readonly reads: RuntimeFileReads
  private readonly mutations: RuntimeFileMutations
  private readonly watches: RuntimeFileWatches
  private readonly terminalPaths: RuntimeTerminalPathResolver

  readonly openMobileFile: RuntimeFileAccess['openMobileFile']
  readonly openMobileDiff: RuntimeFileAccess['openMobileDiff']
  readonly listRuntimeMarkdownDocuments: RuntimeFileAccess['listRuntimeMarkdownDocuments']
  readonly pathsExistRuntimeFiles: RuntimeFileAccess['pathsExistRuntimeFiles']
  readonly statRuntimeFile: RuntimeFileAccess['statRuntimeFile']
  readonly readMobileFile: RuntimeFileReads['readMobileFile']
  readonly readFileExplorerPreview: RuntimeFileReads['readFileExplorerPreview']
  readonly readChatImagePreview: RuntimeFileReads['readChatImagePreview']
  readonly readDocPreviewFile: RuntimeFileReads['readDocPreviewFile']
  readonly readDocPreviewChunk: RuntimeFileReads['readDocPreviewChunk']
  readonly readFileExplorerChunk: RuntimeFileReads['readFileExplorerChunk']
  readonly writeFileExplorerFile: RuntimeFileMutations['writeFileExplorerFile']
  readonly writeFileExplorerFileBase64: RuntimeFileMutations['writeFileExplorerFileBase64']
  readonly writeFileExplorerFileBase64Chunk: RuntimeFileMutations['writeFileExplorerFileBase64Chunk']
  readonly createFileExplorerFile: RuntimeFileMutations['createFileExplorerFile']
  readonly createFileExplorerDir: RuntimeFileMutations['createFileExplorerDir']
  readonly createFileExplorerDirNoClobber: RuntimeFileMutations['createFileExplorerDirNoClobber']
  readonly commitFileExplorerUpload: RuntimeFileMutations['commitFileExplorerUpload']
  readonly replaceFileExplorerFileWithUpload: RuntimeFileMutations['replaceFileExplorerFileWithUpload']
  readonly renameFileExplorerPath: RuntimeFileMutations['renameFileExplorerPath']
  readonly copyFileExplorerPath: RuntimeFileMutations['copyFileExplorerPath']
  readonly deleteFileExplorerPath: RuntimeFileMutations['deleteFileExplorerPath']
  readonly readFileExplorerDir: RuntimeFileWatches['readFileExplorerDir']
  readonly watchFileExplorer: RuntimeFileWatches['watchFileExplorer']
  readonly closeFileExplorerWatchersForPath: RuntimeFileWatches['closeFileExplorerWatchersForPath']
  readonly restoreFileExplorerWatchersAfterFailedRemoval: RuntimeFileWatches['restoreFileExplorerWatchersAfterFailedRemoval']
  readonly forgetFileExplorerWatchersAfterRemoval: RuntimeFileWatches['forgetFileExplorerWatchersAfterRemoval']
  readonly resolveTerminalPath: RuntimeTerminalPathResolver['resolveTerminalPath']
  readonly stagedFileSaves: RuntimeStagedFileSaves

  constructor(host: RuntimeFileCommandHost) {
    this.search = new RuntimeFileSearch(host)
    this.artifacts = new RuntimeTerminalArtifacts(host)
    this.access = new RuntimeFileAccess(host)
    this.reads = new RuntimeFileReads(host)
    this.mutations = new RuntimeFileMutations(host)
    this.stagedFileSaves = new RuntimeStagedFileSaves(host)
    this.watches = new RuntimeFileWatches(host)
    this.terminalPaths = new RuntimeTerminalPathResolver(host, this.artifacts)
    this.openMobileFile = this.access.openMobileFile.bind(this.access)
    this.openMobileDiff = this.access.openMobileDiff.bind(this.access)
    this.listRuntimeMarkdownDocuments = this.access.listRuntimeMarkdownDocuments.bind(this.access)
    this.pathsExistRuntimeFiles = this.access.pathsExistRuntimeFiles.bind(this.access)
    this.statRuntimeFile = this.access.statRuntimeFile.bind(this.access)
    this.readMobileFile = this.reads.readMobileFile.bind(this.reads)
    this.readFileExplorerPreview = this.reads.readFileExplorerPreview.bind(this.reads)
    this.readChatImagePreview = this.reads.readChatImagePreview.bind(this.reads)
    this.readDocPreviewFile = this.reads.readDocPreviewFile.bind(this.reads)
    this.readDocPreviewChunk = this.reads.readDocPreviewChunk.bind(this.reads)
    this.readFileExplorerChunk = this.reads.readFileExplorerChunk.bind(this.reads)
    this.writeFileExplorerFile = this.mutations.writeFileExplorerFile.bind(this.mutations)
    this.writeFileExplorerFileBase64 = this.mutations.writeFileExplorerFileBase64.bind(
      this.mutations
    )
    this.writeFileExplorerFileBase64Chunk = this.mutations.writeFileExplorerFileBase64Chunk.bind(
      this.mutations
    )
    this.createFileExplorerFile = this.mutations.createFileExplorerFile.bind(this.mutations)
    this.createFileExplorerDir = this.mutations.createFileExplorerDir.bind(this.mutations)
    this.createFileExplorerDirNoClobber = this.mutations.createFileExplorerDirNoClobber.bind(
      this.mutations
    )
    this.commitFileExplorerUpload = this.mutations.commitFileExplorerUpload.bind(this.mutations)
    this.replaceFileExplorerFileWithUpload = this.mutations.replaceFileExplorerFileWithUpload.bind(
      this.mutations
    )
    this.renameFileExplorerPath = this.mutations.renameFileExplorerPath.bind(this.mutations)
    this.copyFileExplorerPath = this.mutations.copyFileExplorerPath.bind(this.mutations)
    this.deleteFileExplorerPath = this.mutations.deleteFileExplorerPath.bind(this.mutations)
    this.readFileExplorerDir = this.watches.readFileExplorerDir.bind(this.watches)
    this.watchFileExplorer = this.watches.watchFileExplorer.bind(this.watches)
    this.closeFileExplorerWatchersForPath = this.watches.closeFileExplorerWatchersForPath.bind(
      this.watches
    )
    this.restoreFileExplorerWatchersAfterFailedRemoval =
      this.watches.restoreFileExplorerWatchersAfterFailedRemoval.bind(this.watches)
    this.forgetFileExplorerWatchersAfterRemoval =
      this.watches.forgetFileExplorerWatchersAfterRemoval.bind(this.watches)
    this.resolveTerminalPath = this.terminalPaths.resolveTerminalPath.bind(this.terminalPaths)
  }

  listMobileFiles(...args: Parameters<RuntimeFileSearch['listMobileFiles']>) {
    return this.search.listMobileFiles(...args)
  }

  searchMobileFilePaths(...args: Parameters<RuntimeFileSearch['searchMobileFilePaths']>) {
    return this.search.searchMobileFilePaths(...args)
  }

  searchQuickOpenFilePaths(...args: Parameters<RuntimeFileSearch['searchQuickOpenFilePaths']>) {
    return this.search.searchQuickOpenFilePaths(...args)
  }

  searchRuntimeFiles(...args: Parameters<RuntimeFileSearch['searchRuntimeFiles']>) {
    return this.search.searchRuntimeFiles(...args)
  }

  listRuntimeFiles(...args: Parameters<RuntimeFileSearch['listRuntimeFiles']>) {
    return this.search.listRuntimeFiles(...args)
  }

  readTerminalArtifactFile(
    worktreeSelector: string,
    grantId: string,
    absolutePath: string,
    clientId?: string
  ) {
    return this.artifacts.readTerminalArtifactFile(
      worktreeSelector,
      grantId,
      absolutePath,
      clientId
    )
  }

  readTerminalArtifactPreview(
    worktreeSelector: string,
    grantId: string,
    absolutePath: string,
    clientId?: string,
    maxContentBytes?: number
  ) {
    return this.artifacts.readTerminalArtifactPreview(
      worktreeSelector,
      grantId,
      absolutePath,
      clientId,
      maxContentBytes
    )
  }

  writeTerminalArtifactFile(
    worktreeSelector: string,
    grantId: string,
    absolutePath: string,
    content: string,
    clientId?: string
  ) {
    return this.artifacts.writeTerminalArtifactFile(
      worktreeSelector,
      grantId,
      absolutePath,
      content,
      clientId
    )
  }

  revokeTerminalFileGrantsForClient(clientId: string) {
    return this.artifacts.revokeTerminalFileGrantsForClient(clientId)
  }
}
