import type { RuntimeFileCommandHost } from './file-command-host'
import type { RuntimeFileSearch } from './search/file-search'
import type { RuntimeFileAccess } from './file-access'
import type { RuntimeFileReads } from './file-reads'
import type { RuntimeFileMutations } from './file-mutations'

export type RuntimeFileSearchSurface = Pick<
  RuntimeFileSearch,
  | 'listMobileFiles'
  | 'searchMobileFilePaths'
  | 'searchQuickOpenFilePaths'
  | 'searchRuntimeFiles'
  | 'listRuntimeFiles'
>

export type RuntimeFileAccessSurface = Pick<
  RuntimeFileAccess,
  | 'openMobileFile'
  | 'openMobileDiff'
  | 'listRuntimeMarkdownDocuments'
  | 'pathsExistRuntimeFiles'
  | 'statRuntimeFile'
>

export type RuntimeFileReadsSurface = Pick<
  RuntimeFileReads,
  | 'readMobileFile'
  | 'readFileExplorerPreview'
  | 'readChatImagePreview'
  | 'readFileExplorerChunk'
  | 'readHostFileChunk'
  | 'readDocPreviewFile'
  | 'readDocPreviewChunk'
>

export type RuntimeFileMutationsSurface = Pick<
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
>

export class LazyRuntimeFileSearch implements RuntimeFileSearchSurface {
  private instancePromise: Promise<RuntimeFileSearch> | null = null

  constructor(private readonly host: RuntimeFileCommandHost) {}

  private load(): Promise<RuntimeFileSearch> {
    return (this.instancePromise ??= import('./search/file-search')
      .then(({ RuntimeFileSearch: Ctor }) => new Ctor(this.host))
      .catch((error: unknown) => {
        this.instancePromise = null
        throw error
      }))
  }

  listMobileFiles: RuntimeFileSearchSurface['listMobileFiles'] = async (...args) =>
    (await this.load()).listMobileFiles(...args)

  searchMobileFilePaths: RuntimeFileSearchSurface['searchMobileFilePaths'] = async (...args) =>
    (await this.load()).searchMobileFilePaths(...args)

  searchQuickOpenFilePaths: RuntimeFileSearchSurface['searchQuickOpenFilePaths'] = async (
    ...args
  ) => (await this.load()).searchQuickOpenFilePaths(...args)

  searchRuntimeFiles: RuntimeFileSearchSurface['searchRuntimeFiles'] = async (...args) =>
    (await this.load()).searchRuntimeFiles(...args)

  listRuntimeFiles: RuntimeFileSearchSurface['listRuntimeFiles'] = async (...args) =>
    (await this.load()).listRuntimeFiles(...args)
}

export class LazyRuntimeFileAccess implements RuntimeFileAccessSurface {
  private instancePromise: Promise<RuntimeFileAccess> | null = null

  constructor(private readonly host: RuntimeFileCommandHost) {}

  private load(): Promise<RuntimeFileAccess> {
    return (this.instancePromise ??= import('./file-access')
      .then(({ RuntimeFileAccess: Ctor }) => new Ctor(this.host))
      .catch((error: unknown) => {
        this.instancePromise = null
        throw error
      }))
  }

  openMobileFile: RuntimeFileAccessSurface['openMobileFile'] = async (...args) =>
    (await this.load()).openMobileFile(...args)

  openMobileDiff: RuntimeFileAccessSurface['openMobileDiff'] = async (...args) =>
    (await this.load()).openMobileDiff(...args)

  listRuntimeMarkdownDocuments: RuntimeFileAccessSurface['listRuntimeMarkdownDocuments'] = async (
    ...args
  ) => (await this.load()).listRuntimeMarkdownDocuments(...args)

  pathsExistRuntimeFiles: RuntimeFileAccessSurface['pathsExistRuntimeFiles'] = async (...args) =>
    (await this.load()).pathsExistRuntimeFiles(...args)

  statRuntimeFile: RuntimeFileAccessSurface['statRuntimeFile'] = async (...args) =>
    (await this.load()).statRuntimeFile(...args)
}

export class LazyRuntimeFileReads implements RuntimeFileReadsSurface {
  private instancePromise: Promise<RuntimeFileReads> | null = null

  constructor(private readonly host: RuntimeFileCommandHost) {}

  private load(): Promise<RuntimeFileReads> {
    return (this.instancePromise ??= import('./file-reads')
      .then(({ RuntimeFileReads: Ctor }) => new Ctor(this.host))
      .catch((error: unknown) => {
        this.instancePromise = null
        throw error
      }))
  }

  readMobileFile: RuntimeFileReadsSurface['readMobileFile'] = async (...args) =>
    (await this.load()).readMobileFile(...args)

  readFileExplorerPreview: RuntimeFileReadsSurface['readFileExplorerPreview'] = async (...args) =>
    (await this.load()).readFileExplorerPreview(...args)

  readChatImagePreview: RuntimeFileReadsSurface['readChatImagePreview'] = async (...args) =>
    (await this.load()).readChatImagePreview(...args)

  readFileExplorerChunk: RuntimeFileReadsSurface['readFileExplorerChunk'] = async (...args) =>
    (await this.load()).readFileExplorerChunk(...args)

  readHostFileChunk: RuntimeFileReadsSurface['readHostFileChunk'] = async (...args) =>
    (await this.load()).readHostFileChunk(...args)

  readDocPreviewFile: RuntimeFileReadsSurface['readDocPreviewFile'] = async (...args) =>
    (await this.load()).readDocPreviewFile(...args)

  readDocPreviewChunk: RuntimeFileReadsSurface['readDocPreviewChunk'] = async (...args) =>
    (await this.load()).readDocPreviewChunk(...args)
}

export class LazyRuntimeFileMutations implements RuntimeFileMutationsSurface {
  private instancePromise: Promise<RuntimeFileMutations> | null = null

  constructor(private readonly host: RuntimeFileCommandHost) {}

  private load(): Promise<RuntimeFileMutations> {
    return (this.instancePromise ??= import('./file-mutations')
      .then(({ RuntimeFileMutations: Ctor }) => new Ctor(this.host))
      .catch((error: unknown) => {
        this.instancePromise = null
        throw error
      }))
  }

  writeFileExplorerFile: RuntimeFileMutationsSurface['writeFileExplorerFile'] = async (...args) =>
    (await this.load()).writeFileExplorerFile(...args)

  formatFileExplorerText: RuntimeFileMutationsSurface['formatFileExplorerText'] = async (...args) =>
    (await this.load()).formatFileExplorerText(...args)

  writeFileExplorerFileBase64: RuntimeFileMutationsSurface['writeFileExplorerFileBase64'] = async (
    ...args
  ) => (await this.load()).writeFileExplorerFileBase64(...args)

  writeFileExplorerFileBase64Chunk: RuntimeFileMutationsSurface['writeFileExplorerFileBase64Chunk'] =
    async (...args) => (await this.load()).writeFileExplorerFileBase64Chunk(...args)

  createFileExplorerFile: RuntimeFileMutationsSurface['createFileExplorerFile'] = async (...args) =>
    (await this.load()).createFileExplorerFile(...args)

  createFileExplorerDir: RuntimeFileMutationsSurface['createFileExplorerDir'] = async (...args) =>
    (await this.load()).createFileExplorerDir(...args)

  createFileExplorerDirNoClobber: RuntimeFileMutationsSurface['createFileExplorerDirNoClobber'] =
    async (...args) => (await this.load()).createFileExplorerDirNoClobber(...args)

  commitFileExplorerUpload: RuntimeFileMutationsSurface['commitFileExplorerUpload'] = async (
    ...args
  ) => (await this.load()).commitFileExplorerUpload(...args)

  replaceFileExplorerFileWithUpload: RuntimeFileMutationsSurface['replaceFileExplorerFileWithUpload'] =
    async (...args) => (await this.load()).replaceFileExplorerFileWithUpload(...args)

  renameFileExplorerPath: RuntimeFileMutationsSurface['renameFileExplorerPath'] = async (...args) =>
    (await this.load()).renameFileExplorerPath(...args)

  copyFileExplorerPath: RuntimeFileMutationsSurface['copyFileExplorerPath'] = async (...args) =>
    (await this.load()).copyFileExplorerPath(...args)

  deleteFileExplorerPath: RuntimeFileMutationsSurface['deleteFileExplorerPath'] = async (...args) =>
    (await this.load()).deleteFileExplorerPath(...args)
}
