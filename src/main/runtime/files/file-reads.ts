import { open, stat } from 'node:fs/promises'
import { extname, win32 } from 'node:path'
import type { RuntimeStore } from '../runtime-store-contract'
import type { RuntimeFileCommandHost } from './file-command-host'
import type {
  RuntimeFileReadResult,
  RuntimeFilePreviewResult,
  RuntimeFileReadChunkResult
} from '../../../shared/runtime-types'
import { isMobileBinaryPath, isSafeMobileRelativePath } from './mobile-file-kind'
import { joinWorktreeRelativePath } from '../runtime-relative-paths'
import { truncateMobileFilePreview } from '../terminal/artifacts/artifact-integrity'
import {
  requireLocalRuntimeFileRoute,
  requireRuntimeFileProvider,
  resolveFileExplorerPath,
  resolveFileExplorerPaths
} from './file-target'
import {
  LOCAL_PREVIEWABLE_BINARY_MAX_BYTES,
  MOBILE_FILE_READ_MAX_BYTES,
  RUNTIME_PREVIEWABLE_BINARY_MIME_TYPES,
  assertPreviewWithinTransportBudget,
  previewableBinaryByteLimit
} from './file-preview-budget'
import { readLocalFileRange } from '../../ipc/filesystem/local-file-range-read'
import type { ResolveAuthorizedPathOptions } from '../../ipc/filesystem/filesystem-auth'
import { windowsFsPath } from '../../wsl/wsl-unc-drive-fs-path'
import { guardWslUncPathAccess } from '../../wsl/wsl-unc-access-gate'
import { resolveLocalFileRequestPath } from '../../ipc/local-file-access-resolution'
import type { LocalFileAccess } from '../../../shared/local-file-access'
import { filePreviewForPath } from '../../../shared/file-preview-kind'
import {
  extraRootsForPersistedOpenFile,
  resolveRuntimeAuthorizedPath
} from './chat-scratch-file-root'
import {
  NodeFileReadTooLargeError,
  readNodeFileWithinLimit
} from '../../../shared/node-bounded-file-reader'
import { isBinaryBuffer } from '../../../shared/binary-buffer'
import type {
  DocPreviewFileAccessResult,
  DocPreviewFileChunk,
  DocPreviewFileTarget
} from '../../../shared/doc-preview-file-access'
import type { LocalFilesystemProvider } from '../../providers/local-filesystem-provider'

const CHAT_IMAGE_ACCESS: LocalFileAccess = { kind: 'chat-image' }

type RuntimeFileReadHost = Pick<RuntimeFileCommandHost, 'requireStore' | 'resolveRuntimeFileTarget'>

export class RuntimeFileReads {
  constructor(private readonly host: RuntimeFileReadHost) {}

  async readMobileFile(
    worktreeSelector: string,
    relativePath: string
  ): Promise<RuntimeFileReadResult> {
    const store = this.host.requireStore()
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    const { worktree } = target
    requireLocalRuntimeFileRoute(target)
    const persisted = !isSafeMobileRelativePath(relativePath)
      ? findPersistedOpenFilePath(store, worktree.id, relativePath)
      : null
    if (!isSafeMobileRelativePath(relativePath) && !persisted) {
      throw new Error('invalid_relative_path')
    }
    const targetCheckPath = persisted ? persisted.filePath : relativePath
    if (isMobileBinaryPath(targetCheckPath)) {
      throw new Error('binary_file')
    }

    const filePath = persisted
      ? persisted.filePath
      : joinWorktreeRelativePath(worktree.path, relativePath)
    const content = await readLocalMobileFile(
      filePath,
      store,
      persisted ? { extraRoots: persisted.extraRoots } : undefined
    )
    const truncated = truncateMobileFilePreview(content)

    return {
      worktree: worktree.id,
      relativePath,
      content: truncated.content,
      truncated: truncated.truncated,
      byteLength: truncated.byteLength
    }
  }

  async readFileExplorerPreview(
    worktreeSelector: string,
    relativePath: string,
    maxContentBytes?: number
  ): Promise<RuntimeFilePreviewResult> {
    const store = this.host.requireStore()
    let rawPath: string
    let authOptions: ResolveAuthorizedPathOptions | undefined
    if (!isSafeMobileRelativePath(relativePath)) {
      const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
      requireLocalRuntimeFileRoute(target)
      const persisted = findPersistedOpenFilePath(store, target.worktree.id, relativePath)
      if (!persisted) {
        const explorerTarget = await resolveFileExplorerPath(
          this.host,
          worktreeSelector,
          relativePath
        )
        rawPath = explorerTarget.path
      } else {
        rawPath = persisted.filePath
        authOptions = { extraRoots: persisted.extraRoots }
      }
    } else {
      const target = await resolveFileExplorerPath(this.host, worktreeSelector, relativePath)
      requireLocalRuntimeFileRoute(target)
      rawPath = target.path
    }
    const filePath = await resolveRuntimeAuthorizedPath(rawPath, store, authOptions)
    const mimeType = RUNTIME_PREVIEWABLE_BINARY_MIME_TYPES[extname(filePath).toLowerCase()]
    const buffer = await readPreviewBytes(
      filePath,
      mimeType ? binaryPreviewMaxBytes(maxContentBytes) : MOBILE_FILE_READ_MAX_BYTES
    )
    if (mimeType) {
      return assertPreviewWithinTransportBudget(
        { content: buffer.toString('base64'), isBinary: true, isImage: true, mimeType },
        maxContentBytes
      )
    }

    if (isBinaryBuffer(buffer)) {
      return assertPreviewWithinTransportBudget({ content: '', isBinary: true }, maxContentBytes)
    }
    return assertPreviewWithinTransportBudget(
      { content: buffer.toString('utf-8'), isBinary: false },
      maxContentBytes
    )
  }

  async readDocPreviewFile(
    worktreeSelector: string,
    relativePath: string,
    entryRelativePath: string,
    implicitRootRelativePath: string | null,
    authorizedRootRelativePaths: string[],
    maxContentBytes?: number
  ): Promise<DocPreviewFileAccessResult> {
    const { target, provider } = await this.resolveDocPreviewTarget(
      worktreeSelector,
      relativePath,
      entryRelativePath,
      implicitRootRelativePath,
      authorizedRootRelativePaths
    )
    if (!provider.readDocPreviewFile) {
      throw new Error('Secure document previews require a newer SSH relay')
    }
    return assertPreviewWithinTransportBudget(
      await provider.readDocPreviewFile({
        ...target,
        maxTextBytes: MOBILE_FILE_READ_MAX_BYTES,
        maxBinaryBytes: binaryPreviewMaxBytes(maxContentBytes)
      }),
      maxContentBytes
    )
  }

  async readDocPreviewChunk(
    worktreeSelector: string,
    relativePath: string,
    entryRelativePath: string,
    implicitRootRelativePath: string | null,
    authorizedRootRelativePaths: string[],
    offset: number,
    length: number
  ): Promise<DocPreviewFileChunk> {
    const { target, provider } = await this.resolveDocPreviewTarget(
      worktreeSelector,
      relativePath,
      entryRelativePath,
      implicitRootRelativePath,
      authorizedRootRelativePaths
    )
    return provider.readDocPreviewFileChunk(target, offset, length)
  }

  private async resolveDocPreviewTarget(
    worktreeSelector: string,
    relativePath: string,
    entryRelativePath: string,
    implicitRootRelativePath: string | null,
    authorizedRootRelativePaths: string[]
  ): Promise<{ target: DocPreviewFileTarget; provider: LocalFilesystemProvider }> {
    const relativePaths = [
      '',
      entryRelativePath,
      relativePath,
      ...(implicitRootRelativePath === null ? [] : [implicitRootRelativePath]),
      ...authorizedRootRelativePaths
    ]
    const [boundary, entry, target, ...authorityRoots] = await resolveFileExplorerPaths(
      this.host,
      worktreeSelector,
      relativePaths
    )
    const implicitRoot = implicitRootRelativePath === null ? null : authorityRoots[0]
    const authorizedRoots = authorityRoots.slice(implicitRoot === null ? 0 : 1)
    return {
      target: {
        boundaryPath: boundary.path,
        entryPath: entry.path,
        implicitRootPath: implicitRoot?.path ?? null,
        authorizedRootPaths: authorizedRoots.map((root) => root.path),
        targetPath: target.path
      },
      provider: requireRuntimeFileProvider(target, this.host)
    }
  }

  async readFileExplorerChunk(
    worktreeSelector: string,
    relativePath: string,
    offset: number,
    length: number
  ): Promise<RuntimeFileReadChunkResult> {
    const target = await resolveFileExplorerPath(this.host, worktreeSelector, relativePath)
    requireLocalRuntimeFileRoute(target)
    const filePath = await resolveRuntimeAuthorizedPath(target.path, this.host.requireStore())
    return readLocalFileRange(filePath, offset, length)
  }

  /** A host image a chat names, under desktop's chat-image rule; the path must be on this machine. */
  async readChatImagePreview(
    worktreeSelector: string,
    filePath: string,
    maxContentBytes?: number
  ): Promise<RuntimeFilePreviewResult> {
    requireLocalRuntimeFileRoute(await this.host.resolveRuntimeFileTarget(worktreeSelector))
    const store = this.host.requireStore()
    // Automatic loads never wake a stopped WSL distro.
    return guardWslUncPathAccess(filePath, async () => {
      const imagePath = await resolveLocalFileRequestPath(filePath, CHAT_IMAGE_ACCESS, store)
      // Paths inside project roots skip the rule's type check.
      const preview = filePreviewForPath(imagePath)
      if (preview?.kind !== 'image') {
        throw new Error('not_an_image')
      }
      const { mimeType } = preview
      const buffer = await readPreviewBytes(
        windowsFsPath(imagePath),
        binaryPreviewMaxBytes(maxContentBytes),
        { regularFileOnly: true }
      )
      return assertPreviewWithinTransportBudget(
        { content: buffer.toString('base64'), isBinary: true, isImage: true, mimeType },
        maxContentBytes
      )
    })
  }
}

function binaryPreviewMaxBytes(maxContentBytes: number | undefined): number {
  return maxContentBytes === undefined
    ? LOCAL_PREVIEWABLE_BINARY_MAX_BYTES
    : previewableBinaryByteLimit(maxContentBytes)
}

async function readPreviewBytes(
  filePath: string,
  maxBytes: number,
  options?: { regularFileOnly: true }
): Promise<Buffer> {
  try {
    return (await readNodeFileWithinLimit(filePath, maxBytes, options)).buffer
  } catch (error) {
    if (error instanceof NodeFileReadTooLargeError) {
      throw new Error('file_too_large')
    }
    throw error
  }
}

const WINDOWS_DRIVE_PATH = /^[a-zA-Z]:[\\/]/

// Why: Windows accepts both separators. Compare only drive-letter paths so POSIX
// names containing a backslash never match a different file.
function normalizeWindowsDriveComparisonPath(filePath: string): string {
  const normalized = win32.normalize(filePath)
  return `${normalized.slice(0, 1).toLowerCase()}${normalized.slice(1)}`
}

function sameWindowsDrivePath(left: string, right: string): boolean {
  return (
    WINDOWS_DRIVE_PATH.test(left) &&
    WINDOWS_DRIVE_PATH.test(right) &&
    normalizeWindowsDriveComparisonPath(left) === normalizeWindowsDriveComparisonPath(right)
  )
}

function findPersistedOpenFilePath(
  store: RuntimeStore,
  worktreeId: string,
  relativePath: string
): { filePath: string; extraRoots: readonly string[] } | null {
  const openFile = store
    .getWorkspaceSession?.()
    ?.openFilesByWorktree?.[worktreeId]?.find(
      (candidate) =>
        !candidate.externalSshTargetId &&
        (candidate.relativePath === relativePath ||
          candidate.filePath === relativePath ||
          sameWindowsDrivePath(candidate.filePath, relativePath))
    )
  if (!openFile) {
    return null
  }
  const extraRoots = extraRootsForPersistedOpenFile(openFile.filePath)
  return extraRoots.length > 0 ? { filePath: openFile.filePath, extraRoots } : null
}

async function readLocalMobileFile(
  filePath: string,
  store: RuntimeStore,
  options?: ResolveAuthorizedPathOptions
): Promise<string> {
  // Why: cap the read so opening a large file can't block the WebSocket (previews are read-only convenience views).
  const { bytes } = await readLocalRuntimeFilePrefix(
    filePath,
    store,
    MOBILE_FILE_READ_MAX_BYTES + 1,
    options
  )
  // An extension the list does not know can still be binary; as text, a save would corrupt it.
  if (isBinaryBuffer(bytes)) {
    throw new Error('binary_file')
  }
  return bytes.toString('utf8')
}

export async function readLocalRuntimeFilePrefix(
  filePath: string,
  store: RuntimeStore,
  maxBytes: number,
  options?: ResolveAuthorizedPathOptions
): Promise<{ bytes: Buffer; size: number }> {
  const authorizedPath = windowsFsPath(
    await resolveRuntimeAuthorizedPath(filePath, store, options)
  )
  const fileStat = await stat(authorizedPath)
  const readLimit = Math.min(fileStat.size, maxBytes)
  const handle = await open(authorizedPath, 'r')
  try {
    const buffer = Buffer.alloc(readLimit)
    const { bytesRead } = await handle.read(buffer, 0, readLimit, 0)
    return { bytes: buffer.subarray(0, bytesRead), size: fileStat.size }
  } finally {
    await handle.close()
  }
}
