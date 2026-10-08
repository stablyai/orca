import { open, stat } from 'node:fs/promises'
import { MAX_FILE_RANGE_READ_BYTES } from '../../shared/file-range-read'
import {
  MOBILE_MARKDOWN_READ_MAX_BYTES,
  utf8ByteLength
} from '../../shared/mobile-markdown-document'
import { resolveAuthorizedPath } from '../ipc/filesystem-auth'
import type { Store } from '../persistence'
import type { IFilesystemProvider } from '../providers/types'
import { isBinaryBuffer } from './runtime-file-command-host'

export type MarkdownDocumentRead = {
  content: string
  /** The whole file's UTF-8 size, even when `content` is a prefix. */
  byteLength: number
  truncated: boolean
}

/** Cuts a byte prefix back to a UTF-8 character boundary so no character is split. */
export function utf8SafePrefix(buffer: Buffer, maxBytes: number): Buffer {
  if (buffer.length <= maxBytes) {
    return buffer
  }
  let end = maxBytes
  // Why: bytes 10xxxxxx continue a character that started before `end`.
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) {
    end -= 1
  }
  return buffer.subarray(0, end)
}

function decodeDocumentPrefix(buffer: Buffer, fileSize: number): MarkdownDocumentRead {
  if (isBinaryBuffer(buffer)) {
    throw new Error('binary_file')
  }
  const truncated = fileSize > MOBILE_MARKDOWN_READ_MAX_BYTES
  const content = utf8SafePrefix(buffer, MOBILE_MARKDOWN_READ_MAX_BYTES).toString('utf8')
  return { content, byteLength: truncated ? fileSize : utf8ByteLength(content), truncated }
}

export async function readLocalMarkdownDocument(
  filePath: string,
  store: Store
): Promise<MarkdownDocumentRead> {
  const authorizedPath = await resolveAuthorizedPath(filePath, store)
  const fileStat = await stat(authorizedPath)
  if (fileStat.isDirectory()) {
    throw new Error('Cannot read a directory')
  }
  // Why +1: reading past the budget is how the boundary check sees a split character.
  const readLimit = Math.min(fileStat.size, MOBILE_MARKDOWN_READ_MAX_BYTES + 1)
  const handle = await open(authorizedPath, 'r')
  try {
    const buffer = Buffer.alloc(readLimit)
    const { bytesRead } = await handle.read(buffer, 0, readLimit, 0)
    return decodeDocumentPrefix(buffer.subarray(0, bytesRead), fileStat.size)
  } finally {
    await handle.close()
  }
}

/**
 * Reads through the SSH provider on the execution host. Small files come whole; larger ones need
 * the relay's positional reads for a bounded prefix; a relay without them answers the too-large
 * code phones already explain.
 */
export async function readSshMarkdownDocument(
  filePath: string,
  provider: IFilesystemProvider
): Promise<MarkdownDocumentRead> {
  const fileStat = await provider.stat(filePath)
  if (fileStat.type === 'directory') {
    throw new Error('Cannot read a directory')
  }
  if (fileStat.size <= MOBILE_MARKDOWN_READ_MAX_BYTES) {
    const result = await provider.readFile(filePath, {
      maxTextBytes: MOBILE_MARKDOWN_READ_MAX_BYTES
    })
    if (result.isBinary) {
      throw new Error('binary_file')
    }
    return { content: result.content, byteLength: utf8ByteLength(result.content), truncated: false }
  }
  if (!provider.readFileRange || !(await provider.supportsFileRangeRead?.())) {
    throw new Error('file_too_large')
  }
  const chunks: Buffer[] = []
  let position = 0
  const wanted = MOBILE_MARKDOWN_READ_MAX_BYTES + 1
  while (position < wanted) {
    const length = Math.min(MAX_FILE_RANGE_READ_BYTES, wanted - position)
    const range = await provider.readFileRange(filePath, position, length)
    chunks.push(range.bytes.subarray(0, range.bytesRead))
    position += range.bytesRead
    if (range.bytesRead < length) {
      break
    }
  }
  return decodeDocumentPrefix(Buffer.concat(chunks), fileStat.size)
}
