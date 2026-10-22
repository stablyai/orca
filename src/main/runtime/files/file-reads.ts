import { open, stat } from 'node:fs/promises'
import { extname } from 'node:path'
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
import { resolveRuntimeAuthorizedPath } from './chat-scratch-file-root'
import {
  NodeFileReadTooLargeError,
  readNodeFileWithinLimit
} from '../../../shared/node-bounded-file-reader'
import { isBinaryBuffer } from '../../../shared/binary-buffer'
import type {
  DocPreviewFileAccessRequest,
  DocPreviewFileAccessResult
} from '../../../shared/doc-preview-file-access'

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
    // Why: an `ssh:` host fails before path validation, as it always has.
    requireLocalRuntimeFileRoute(target)
    if (!isSafeMobileRelativePath(relativePath)) {
      throw new Error('invalid_relative_path')
    }
    if (isMobileBinaryPath(relativePath)) {
      throw new Error('binary_file')
    }

    const filePath = joinWorktreeRelativePath(worktree.path, relativePath)
    const content = await readLocalMobileFile(filePath, store)
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
    const binaryMaxBytes =
      maxContentBytes === undefined
        ? LOCAL_PREVIEWABLE_BINARY_MAX_BYTES
        : previewableBinaryByteLimit(maxContentBytes)
    const target = await resolveFileExplorerPath(this.host, worktreeSelector, relativePath)
    requireLocalRuntimeFileRoute(target)
    // Why: sized by extension instead of a stat round trip.
    const filePath = await resolveRuntimeAuthorizedPath(target.path, this.host.requireStore())
    const mimeType = RUNTIME_PREVIEWABLE_BINARY_MIME_TYPES[extname(filePath).toLowerCase()]
    const maxBytes = mimeType ? binaryMaxBytes : MOBILE_FILE_READ_MAX_BYTES
    let buffer: Buffer
    try {
      buffer = (await readNodeFileWithinLimit(filePath, maxBytes)).buffer
    } catch (error) {
      if (error instanceof NodeFileReadTooLargeError) {
        throw new Error('file_too_large')
      }
      throw error
    }
    if (mimeType) {
      return assertPreviewWithinTransportBudget(
        {
          content: buffer.toString('base64'),
          isBinary: true,
          isImage: true,
          mimeType
        },
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
    const binaryMaxBytes =
      maxContentBytes === undefined
        ? LOCAL_PREVIEWABLE_BINARY_MAX_BYTES
        : previewableBinaryByteLimit(maxContentBytes)
    const request: DocPreviewFileAccessRequest = {
      boundaryPath: boundary.path,
      entryPath: entry.path,
      implicitRootPath: implicitRoot?.path ?? null,
      authorizedRootPaths: authorizedRoots.map((root) => root.path),
      targetPath: target.path,
      maxTextBytes: MOBILE_FILE_READ_MAX_BYTES,
      maxBinaryBytes: binaryMaxBytes
    }
    const provider = requireRuntimeFileProvider(target, this.host)
    if (!provider.readDocPreviewFile) {
      throw new Error('Secure document previews require a newer SSH relay')
    }
    return assertPreviewWithinTransportBudget(
      await provider.readDocPreviewFile(request),
      maxContentBytes
    )
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
}

async function readLocalMobileFile(filePath: string, store: RuntimeStore): Promise<string> {
  // Why: cap the read so opening a large file can't block the WebSocket (previews are read-only convenience views).
  const { bytes } = await readLocalRuntimeFilePrefix(
    filePath,
    store,
    MOBILE_FILE_READ_MAX_BYTES + 1
  )
  return bytes.toString('utf8')
}

/** Up to `maxBytes` from the start of an authorized local file, and the file's full size. */
export async function readLocalRuntimeFilePrefix(
  filePath: string,
  store: RuntimeStore,
  maxBytes: number
): Promise<{ bytes: Buffer; size: number }> {
  const authorizedPath = await resolveRuntimeAuthorizedPath(filePath, store)
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
