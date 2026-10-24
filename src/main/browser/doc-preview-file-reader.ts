import { extname } from 'node:path'
import type { RuntimeFilePreviewResult } from '../../shared/runtime-file-contracts'
import type { DocPreviewFileFailureReason } from '../../shared/doc-preview-scheme'
import { FONT_FILE_MIME_TYPES } from '../../shared/font-file-extensions'
import { callRuntimeEnvironment } from '../ipc/runtime-environments/runtime-environment-transport-routing'
import { getCanonicalUserDataPath } from '../persistence'
import { SSH_HOST_NOT_SERVED_MESSAGE } from '../providers/ssh-host-not-served-error'
import {
  resolveDocPreviewAuthorityPaths,
  resolveDocPreviewCandidatePath,
  resolveDocPreviewTargetPath,
  toRuntimeWorktreeRelativeDirectoryPath,
  toRuntimeWorktreeRelativePath,
  type DocPreviewGrant
} from './doc-preview-grant-registry'

const DOC_PREVIEW_READ_TIMEOUT_MS = 15_000

const UNSERVABLE_ASSET_PREVIEW_MESSAGE = 'This workspace cannot send this file type to a preview.'

// Reject clamped text rather than rendering a partial document.
const TRUNCATED_PREVIEW_MESSAGE = 'This document is too large for the server to send in full.'

const RUNTIME_TOO_LARGE_ERROR = 'file_too_large'

const RUNTIME_DOC_PREVIEW_UPDATE_REQUIRED_MESSAGE =
  'Secure document previews require a newer Orca on the paired machine. Update it and try again.'

function isTooLargeReadError(error: unknown): boolean {
  return error instanceof Error && error.message === RUNTIME_TOO_LARGE_ERROR
}

export type DocPreviewReadOutcome =
  | { ok: true; bytes: Buffer; contentType: string }
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
  ...FONT_FILE_MIME_TYPES
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

function toOutcome(source: PreviewFileBytes, contentType: string): DocPreviewReadOutcome {
  if (source.truncated) {
    return { ok: false, status: 413, reason: 'too-large', message: TRUNCATED_PREVIEW_MESSAGE }
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
    : {
        ok: false,
        status: 415,
        reason: 'unsupported-asset',
        message: UNSERVABLE_ASSET_PREVIEW_MESSAGE
      }
}

async function readRuntimeDocPreviewFile(
  environmentId: string,
  worktreeSelector: string,
  relativePath: string,
  entryRelativePath: string,
  implicitRootRelativePath: string | null,
  authorizedRootRelativePaths: string[]
): Promise<PreviewFileBytes> {
  const userDataPath = getCanonicalUserDataPath()
  const response = await callRuntimeEnvironment(
    userDataPath,
    environmentId,
    'files.readDocPreview',
    {
      worktree: worktreeSelector,
      relativePath,
      entryRelativePath,
      implicitRootRelativePath,
      authorizedRootRelativePaths
    },
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

function notFoundOutcome(message = 'Not found'): DocPreviewReadOutcome {
  return { ok: false, status: 404, reason: 'unreadable', message }
}

export async function readDocPreviewFile(
  grant: DocPreviewGrant,
  relativePath: string
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
  try {
    if (grant.owner.kind === 'ssh') {
      return notFoundOutcome(SSH_HOST_NOT_SERVED_MESSAGE)
    }
    const runtimeOwner = grant.owner
    const worktreeRelativePath = toRuntimeWorktreeRelativePath(
      runtimeOwner.worktreeRoot,
      absolutePath
    )
    const authority = resolveDocPreviewAuthorityPaths(grant)
    const entryRelativePath = authority.entryPath
      ? toRuntimeWorktreeRelativePath(runtimeOwner.worktreeRoot, authority.entryPath)
      : null
    const implicitRootRelativePath = authority.implicitRootPath
      ? toRuntimeWorktreeRelativeDirectoryPath(
          runtimeOwner.worktreeRoot,
          authority.implicitRootPath
        )
      : null
    const authorizedRootRelativePaths = authority.authorizedRootPaths
      .map((root) => toRuntimeWorktreeRelativeDirectoryPath(runtimeOwner.worktreeRoot, root))
      .filter((root): root is string => root !== null)
    if (!worktreeRelativePath || !entryRelativePath) {
      // Runtime file reads cannot address documents outside the worktree.
      return notFoundOutcome()
    }
    return toOutcome(
      await readRuntimeDocPreviewFile(
        runtimeOwner.environmentId,
        runtimeOwner.worktreeSelector,
        worktreeRelativePath,
        entryRelativePath,
        implicitRootRelativePath,
        authorizedRootRelativePaths
      ),
      contentType
    )
  } catch (error) {
    return isTooLargeReadError(error)
      ? { ok: false, status: 413, reason: 'too-large', message: TRUNCATED_PREVIEW_MESSAGE }
      : notFoundOutcome(error instanceof Error ? error.message : undefined)
  }
}
