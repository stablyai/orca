import { extname } from 'node:path'
import type { RuntimeFilePreviewResult } from '../../../shared/file-content/runtime-file-read'
import type { DocPreviewFileFailureReason } from '../../../shared/document-preview/doc-preview-scheme'
import { FONT_FILE_MIME_TYPES } from '../../../shared/file-preview/font-file-extensions'
import { MEDIA_FILE_MIME_TYPES } from '../../../shared/file-preview/media-mime-types'
import { isBinaryBuffer } from '../../../shared/file-preview/binary-buffer'
import {
  DOC_PREVIEW_FILE_CHANGED_MESSAGE,
  type DocPreviewFileChunk
} from '../../../shared/document-preview/doc-preview-file-access'
import { callRuntimeEnvironment } from '../../ipc/runtime-environments/requests/runtime-environment-transport-routing'
import {
  getDocPreviewGrant,
  resolveDocPreviewAuthorityPaths,
  resolveDocPreviewCandidatePath,
  resolveDocPreviewTargetPath,
  toRuntimeWorktreeRelativeDirectoryPath,
  toRuntimeWorktreeRelativePath,
  type DocPreviewGrant
} from './doc-preview-grant-registry'
import { getRuntimeEnvironmentRegistryRoot } from '../../ipc/runtime-environments/catalog/runtime-environment-registry-root'
import {
  readDocPreviewGrantedFile,
  readDocPreviewTerminalFile
} from './doc-preview-terminal-file-reader'
import {
  openGrantedDocPreviewMedia,
  openWorkspaceDocPreviewMedia,
  readRuntimeDocPreviewChunk,
  RUNTIME_TOO_LARGE_ERROR,
  type DocPreviewMediaRequest,
  type DocPreviewMediaSource
} from './doc-preview-ranged-read'
import type { RuntimeDocPreviewReadParams } from './doc-preview-runtime-read-contract'
import { REMOTE_PREVIEW_UPDATE_REQUIRED_MESSAGE } from '../../media/remote-file-preview-reader'

const DOC_PREVIEW_READ_TIMEOUT_MS = 15_000
// Why: under files.readDocPreviewChunk's 512 KiB cap, and a multiple of 3 so its base64 has no padding.
const DOC_PREVIEW_CHUNK_BYTES = 384 * 1024

const UNSERVABLE_ASSET_PREVIEW_MESSAGE = 'This workspace cannot send this file type to a preview.'

// Reject clamped text rather than rendering a partial document.
const TRUNCATED_PREVIEW_MESSAGE = 'This document is too large for the server to send in full.'

const RUNTIME_DOC_PREVIEW_UPDATE_REQUIRED_MESSAGE =
  'Secure document previews require a newer Orca on the paired machine. Update it and try again.'

function isTooLargeReadError(error: unknown): boolean {
  return error instanceof Error && error.message === RUNTIME_TOO_LARGE_ERROR
}

export type DocPreviewReadOutcome =
  | { ok: true; bytes: Buffer; contentType: string }
  | { ok: true; media: DocPreviewMediaSource; contentType: string }
  | { ok: false; status: number; reason: DocPreviewFileFailureReason; message: string }

const DOC_PREVIEW_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  ...FONT_FILE_MIME_TYPES,
  ...MEDIA_FILE_MIME_TYPES
}

function isDocPreviewMediaPath(path: string): boolean {
  return MEDIA_FILE_MIME_TYPES[extname(path).toLowerCase()] !== undefined
}

export function docPreviewContentType(relativePath: string): string {
  return (
    DOC_PREVIEW_CONTENT_TYPES[extname(relativePath).toLowerCase()] ?? 'application/octet-stream'
  )
}

type PreviewFileBytes = {
  content: string
  isBinary: boolean
  truncated?: boolean
  /** Distinguishes a served empty binary from an unsupported format. */
  mimeType?: string
}

const TOO_LARGE_OUTCOME: DocPreviewReadOutcome = {
  ok: false,
  status: 413,
  reason: 'too-large',
  message: TRUNCATED_PREVIEW_MESSAGE
}

const UNSUPPORTED_ASSET_OUTCOME: DocPreviewReadOutcome = {
  ok: false,
  status: 415,
  reason: 'unsupported-asset',
  message: UNSERVABLE_ASSET_PREVIEW_MESSAGE
}

function toOutcome(source: PreviewFileBytes, contentType: string): DocPreviewReadOutcome {
  if (source.truncated) {
    return TOO_LARGE_OUTCOME
  }
  if (!source.isBinary) {
    return { ok: true, bytes: Buffer.from(source.content, 'utf8'), contentType }
  }
  if (source.content) {
    return { ok: true, bytes: Buffer.from(source.content, 'base64'), contentType }
  }
  // Older hosts use empty binary content without a MIME type to signal an unsupported format.
  return source.mimeType
    ? { ok: true, bytes: Buffer.alloc(0), contentType }
    : UNSUPPORTED_ASSET_OUTCOME
}

async function readRuntimeDocPreviewFile(
  environmentId: string,
  params: RuntimeDocPreviewReadParams
): Promise<PreviewFileBytes> {
  const response = await callRuntimeEnvironment(
    getRuntimeEnvironmentRegistryRoot(),
    environmentId,
    'files.readDocPreview',
    params,
    DOC_PREVIEW_READ_TIMEOUT_MS
  )
  if (!response.ok) {
    // Old hosts lack scoped reads; report the required update instead of method_not_found.
    throw new Error(
      response.error.code === 'method_not_found'
        ? RUNTIME_DOC_PREVIEW_UPDATE_REQUIRED_MESSAGE
        : response.error.message
    )
  }
  const preview = response.result as RuntimeFilePreviewResult
  return {
    content: preview.content,
    isBinary: preview.isBinary,
    ...(preview.mimeType ? { mimeType: preview.mimeType } : {})
  }
}

/** A file too large for one reply, read by range under the same grant checks as a whole read. */
async function readRuntimeDocPreviewFileInChunks(
  grant: DocPreviewGrant,
  environmentId: string,
  params: RuntimeDocPreviewReadParams
): Promise<{ bytes: Buffer; mimeType?: string }> {
  const chunks: Buffer[] = []
  let first: DocPreviewFileChunk | null = null
  let offset = 0
  do {
    // Why: a closed preview revokes its grant; stop paging a file nobody will see.
    if (!getDocPreviewGrant(grant.id)) {
      throw new Error('Not found')
    }
    const chunk = await readRuntimeDocPreviewChunk(
      environmentId,
      params,
      offset,
      DOC_PREVIEW_CHUNK_BYTES
    )
    first ??= chunk
    const bytes = Buffer.from(chunk.contentBase64, 'base64')
    // Why: every chunk reports the opened file's version, so a rewrite between chunks is never spliced.
    if (
      bytes.length === 0 ||
      offset + bytes.length > first.size ||
      chunk.size !== first.size ||
      chunk.mtimeMs !== first.mtimeMs ||
      chunk.ctimeMs !== first.ctimeMs
    ) {
      throw new Error(DOC_PREVIEW_FILE_CHANGED_MESSAGE)
    }
    chunks.push(bytes)
    offset += bytes.length
  } while (offset < first.size)
  return { bytes: Buffer.concat(chunks), mimeType: first.mimeType }
}

function notFoundOutcome(message = 'Not found'): DocPreviewReadOutcome {
  return { ok: false, status: 404, reason: 'unreadable', message }
}

function runtimeWorkspaceReadParams(
  grant: DocPreviewGrant,
  absolutePath: string
): RuntimeDocPreviewReadParams | null {
  const { worktreeRoot, worktreeSelector } = grant.owner
  const worktreeRelativePath = toRuntimeWorktreeRelativePath(worktreeRoot, absolutePath)
  const authority = resolveDocPreviewAuthorityPaths(grant)
  const entryRelativePath = authority.entryPath
    ? toRuntimeWorktreeRelativePath(worktreeRoot, authority.entryPath)
    : null
  if (!worktreeRelativePath || !entryRelativePath) {
    return null
  }
  return {
    worktree: worktreeSelector,
    relativePath: worktreeRelativePath,
    entryRelativePath,
    implicitRootRelativePath: authority.implicitRootPath
      ? toRuntimeWorktreeRelativeDirectoryPath(worktreeRoot, authority.implicitRootPath)
      : null,
    authorizedRootRelativePaths: authority.authorizedRootPaths
      .map((root) => toRuntimeWorktreeRelativeDirectoryPath(worktreeRoot, root))
      .filter((root): root is string => root !== null)
  }
}

export async function readDocPreviewFile(
  grant: DocPreviewGrant,
  relativePath: string,
  mediaRequest: DocPreviewMediaRequest = {
    firstRead: { offset: 0, length: 1 },
    signal: new AbortController().signal
  }
): Promise<DocPreviewReadOutcome> {
  const candidatePath = resolveDocPreviewCandidatePath(grant, relativePath)
  if (!candidatePath) {
    return notFoundOutcome()
  }
  const absolutePath = resolveDocPreviewTargetPath(grant, relativePath)
  if (!absolutePath) {
    return {
      ok: false,
      status: 403,
      reason: 'authorization-required',
      message: 'This file needs permission before the preview can read it.'
    }
  }
  const contentType = docPreviewContentType(relativePath)
  const media = isDocPreviewMediaPath(relativePath)
  try {
    const runtimeOwner = grant.owner
    const terminalRead =
      runtimeOwner.fileAccess === 'terminal-artifact'
        ? await readDocPreviewTerminalFile(grant, absolutePath)
        : null
    if (terminalRead && 'grantedFile' in terminalRead) {
      const { grantedFile } = terminalRead
      // Classify the host's target, so a media-named link can't stream another file type.
      if (!media || !isDocPreviewMediaPath(grantedFile.absolutePath)) {
        return toOutcome(await readDocPreviewGrantedFile(grantedFile), contentType)
      }
      const source = await openGrantedDocPreviewMedia(grant, grantedFile, mediaRequest).catch(
        (error: unknown) => {
          // Hosts without granted-file range reads can only be updated.
          if (error instanceof Error && error.message === REMOTE_PREVIEW_UPDATE_REQUIRED_MESSAGE) {
            return null
          }
          throw error
        }
      )
      return source ? { ok: true, media: source, contentType } : UNSUPPORTED_ASSET_OUTCOME
    }
    const params = terminalRead?.workspaceParams ?? runtimeWorkspaceReadParams(grant, absolutePath)
    if (!params) {
      // Runtime file reads cannot address documents outside the worktree.
      return notFoundOutcome()
    }
    if (media) {
      const source = await openWorkspaceDocPreviewMedia(
        grant,
        runtimeOwner.environmentId,
        params,
        mediaRequest
      ).catch((error: unknown) => {
        // Hosts before media previews refuse it by size or lack ranged reads.
        if (isTooLargeReadError(error)) {
          return null
        }
        throw error
      })
      return source ? { ok: true, media: source, contentType } : UNSUPPORTED_ASSET_OUTCOME
    }
    try {
      return toOutcome(
        await readRuntimeDocPreviewFile(runtimeOwner.environmentId, params),
        contentType
      )
    } catch (error) {
      if (!isTooLargeReadError(error)) {
        throw error
      }
      const paged = await readRuntimeDocPreviewFileInChunks(
        grant,
        runtimeOwner.environmentId,
        params
      )
      // The sniff the host applies to a whole text read.
      return !paged.mimeType && isBinaryBuffer(paged.bytes)
        ? UNSUPPORTED_ASSET_OUTCOME
        : { ok: true, bytes: paged.bytes, contentType }
    }
  } catch (error) {
    return isTooLargeReadError(error)
      ? TOO_LARGE_OUTCOME
      : notFoundOutcome(error instanceof Error ? error.message : undefined)
  }
}
