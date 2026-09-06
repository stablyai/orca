// @ts-nocheck -- mechanically split class members.
import { RuntimeFileCommandsWithAssertRemoteTerminalFileGrantPathStillCanonical } from './runtime-file-commands-assert-remote-terminal-file-grant-path-still-canonical'
import type {
  RuntimeFilePreviewResult,
  RuntimeFileReadChunkResult
} from '../../shared/runtime-types'
import {
  LOCAL_PREVIEWABLE_BINARY_MAX_BYTES,
  MOBILE_FILE_READ_MAX_BYTES,
  RUNTIME_PREVIEWABLE_BINARY_MIME_TYPES,
  assertPreviewWithinTransportBudget,
  previewableBinaryByteLimit,
  readPreviewFileWithinCap
} from './runtime-file-commands-mobile-file-list-limit'
import { requireRuntimeFileProvider } from './runtime-file-command-target'
import { open, stat } from 'node:fs/promises'
import { resolveAuthorizedPath } from '../ipc/filesystem-auth'
import { extname } from 'node:path'
import {
  NodeFileReadTooLargeError,
  readNodeFileWithinLimit
} from '../../shared/node-bounded-file-reader'
import { isBinaryBuffer } from './runtime-file-command-host'
import type {
  DocPreviewFileAccessRequest,
  DocPreviewFileAccessResult
} from '../../shared/doc-preview-file-access'
import { readAuthorizedDocPreviewFile } from '../../shared/doc-preview-file-access'
import { readSshFileExplorerChunk } from './ssh-file-explorer-chunk-read'

export class RuntimeFileCommandsWithReadFileExplorerPreview extends RuntimeFileCommandsWithAssertRemoteTerminalFileGrantPathStillCanonical {
  async readFileExplorerPreview(
    worktreeSelector: string,
    relativePath: string,
    maxContentBytes?: number
  ): Promise<RuntimeFilePreviewResult> {
    const binaryMaxBytes =
      maxContentBytes === undefined
        ? LOCAL_PREVIEWABLE_BINARY_MAX_BYTES
        : previewableBinaryByteLimit(maxContentBytes)
    const target = await this.resolveFileExplorerPath(worktreeSelector, relativePath)
    const provider = requireRuntimeFileProvider(target)
    if (provider) {
      const fileStats = await provider.stat(target.path)
      if (fileStats.size > binaryMaxBytes) {
        throw new Error('file_too_large')
      }
      const result = await readPreviewFileWithinCap(provider, target.path, {
        maxBinaryBytes: binaryMaxBytes,
        maxTextBytes: MOBILE_FILE_READ_MAX_BYTES
      })
      // Why: the stat gate sizes base64 binaries; text crosses the wire JSON-escaped (up to 6x), so
      // hold it to the same decoded limit the local branch enforces before reading.
      if (
        !result.isBinary &&
        Buffer.byteLength(result.content, 'utf8') > MOBILE_FILE_READ_MAX_BYTES
      ) {
        throw new Error('file_too_large')
      }
      if (
        result.isBinary &&
        maxContentBytes !== undefined &&
        Buffer.byteLength(result.content, 'utf8') > maxContentBytes
      ) {
        throw new Error('file_too_large')
      }
      return assertPreviewWithinTransportBudget(result, maxContentBytes)
    }

    const filePath = await resolveAuthorizedPath(target.path, this.host.requireStore())
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
    const [boundary, entry, target, ...authorityRoots] = await this.resolveFileExplorerPaths(
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
    const provider = requireRuntimeFileProvider(target)
    if (provider && !provider.readDocPreviewFile) {
      throw new Error('Secure document previews require a newer SSH relay')
    }
    const result = provider?.readDocPreviewFile
      ? await provider.readDocPreviewFile(request)
      : await readAuthorizedDocPreviewFile(request)
    return assertPreviewWithinTransportBudget(result, maxContentBytes)
  }

  async readFileExplorerChunk(
    worktreeSelector: string,
    relativePath: string,
    offset: number,
    length: number
  ): Promise<RuntimeFileReadChunkResult> {
    const target = await this.resolveFileExplorerPath(worktreeSelector, relativePath)
    const provider = requireRuntimeFileProvider(target)
    if (provider) {
      const fileStat = await provider.stat(target.path)
      if (fileStat.type === 'directory') {
        throw new Error('Cannot download a directory')
      }
      return readSshFileExplorerChunk(provider, target.path, fileStat.size, offset, length)
    }

    const filePath = await resolveAuthorizedPath(target.path, this.host.requireStore())
    const fileStats = await stat(filePath)
    if (fileStats.isDirectory()) {
      throw new Error('Cannot download a directory')
    }
    const handle = await open(filePath, 'r')
    try {
      const buffer = Buffer.alloc(Math.min(length, Math.max(0, fileStats.size - offset)))
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, offset)
      const chunk = buffer.subarray(0, bytesRead)
      return {
        contentBase64: chunk.toString('base64'),
        bytesRead,
        eof: offset + bytesRead >= fileStats.size
      }
    } finally {
      await handle.close()
    }
  }
}
