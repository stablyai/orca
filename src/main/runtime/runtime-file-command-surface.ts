import type { RuntimeFileCommands } from './orca-runtime-files'

type RuntimeFileCommandName =
  | 'listMobileFiles'
  | 'searchMobileFilePaths'
  | 'searchQuickOpenFilePaths'
  | 'openMobileFile'
  | 'openMobileDiff'
  | 'readMobileFile'
  | 'resolveTerminalPath'
  | 'readTerminalArtifactFile'
  | 'readTerminalArtifactPreview'
  | 'writeTerminalArtifactFile'
  | 'revokeTerminalFileGrantsForClient'
  | 'readFileExplorerDir'
  | 'watchFileExplorer'
  | 'readFileExplorerPreview'
  | 'readFileExplorerChunk'
  | 'readDocPreviewFile'
  | 'writeFileExplorerFile'
  | 'writeFileExplorerFileBase64'
  | 'writeFileExplorerFileBase64Chunk'
  | 'createFileExplorerFile'
  | 'createFileExplorerDir'
  | 'createFileExplorerDirNoClobber'
  | 'commitFileExplorerUpload'
  | 'renameFileExplorerPath'
  | 'copyFileExplorerPath'
  | 'deleteFileExplorerPath'
  | 'searchRuntimeFiles'
  | 'listRuntimeFiles'
  | 'listRuntimeMarkdownDocuments'
  | 'statRuntimeFile'

export type RuntimeFileCommandSurface = Pick<RuntimeFileCommands, RuntimeFileCommandName>

export function installRuntimeFileCommandSurface(
  target: RuntimeFileCommandSurface,
  commands: RuntimeFileCommands
): void {
  Object.assign(target, {
    listMobileFiles: commands.listMobileFiles.bind(commands),
    searchMobileFilePaths: commands.searchMobileFilePaths.bind(commands),
    searchQuickOpenFilePaths: commands.searchQuickOpenFilePaths.bind(commands),
    openMobileFile: commands.openMobileFile.bind(commands),
    openMobileDiff: commands.openMobileDiff.bind(commands),
    readMobileFile: commands.readMobileFile.bind(commands),
    resolveTerminalPath: commands.resolveTerminalPath.bind(commands),
    readTerminalArtifactFile: commands.readTerminalArtifactFile.bind(commands),
    readTerminalArtifactPreview: commands.readTerminalArtifactPreview.bind(commands),
    writeTerminalArtifactFile: commands.writeTerminalArtifactFile.bind(commands),
    revokeTerminalFileGrantsForClient: commands.revokeTerminalFileGrantsForClient.bind(commands),
    readFileExplorerDir: commands.readFileExplorerDir.bind(commands),
    watchFileExplorer: commands.watchFileExplorer.bind(commands),
    readFileExplorerPreview: commands.readFileExplorerPreview.bind(commands),
    readFileExplorerChunk: commands.readFileExplorerChunk.bind(commands),
    readDocPreviewFile: commands.readDocPreviewFile.bind(commands),
    writeFileExplorerFile: commands.writeFileExplorerFile.bind(commands),
    writeFileExplorerFileBase64: commands.writeFileExplorerFileBase64.bind(commands),
    writeFileExplorerFileBase64Chunk: commands.writeFileExplorerFileBase64Chunk.bind(commands),
    createFileExplorerFile: commands.createFileExplorerFile.bind(commands),
    createFileExplorerDir: commands.createFileExplorerDir.bind(commands),
    createFileExplorerDirNoClobber: commands.createFileExplorerDirNoClobber.bind(commands),
    commitFileExplorerUpload: commands.commitFileExplorerUpload.bind(commands),
    renameFileExplorerPath: commands.renameFileExplorerPath.bind(commands),
    copyFileExplorerPath: commands.copyFileExplorerPath.bind(commands),
    deleteFileExplorerPath: commands.deleteFileExplorerPath.bind(commands),
    searchRuntimeFiles: commands.searchRuntimeFiles.bind(commands),
    listRuntimeFiles: commands.listRuntimeFiles.bind(commands),
    listRuntimeMarkdownDocuments: commands.listRuntimeMarkdownDocuments.bind(commands),
    statRuntimeFile: commands.statRuntimeFile.bind(commands)
  } satisfies RuntimeFileCommandSurface)
}
