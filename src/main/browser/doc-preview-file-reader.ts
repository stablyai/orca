import { extname } from 'node:path'
import type {
  RuntimeFilePreviewResult,
  RuntimeFileReadResult
} from '../../shared/runtime-file-contracts'
import type { DocPreviewFileFailureReason } from '../../shared/doc-preview-scheme'
import { callRuntimeEnvironment } from '../ipc/runtime-environment-transport-routing'
import { FileReadCapExceededError } from '../ssh/ssh-filesystem-stream-reader'
import { getCanonicalUserDataPath } from '../persistence'
import { requireSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import {
  resolveCanonicalDocPreviewPath,
  resolveDocPreviewTargetPath,
  toRuntimeWorktreeRelativePath,
  type DocPreviewGrant
} from './doc-preview-grant-registry'

const DOC_PREVIEW_READ_TIMEOUT_MS = 15_000

/** Why not "needs a newer server": the SSH read path only ever serves images and PDFs as bytes, so
 *  a font is refused there by design, not by version. Name the file type, not the host's age. */
const UNSERVABLE_ASSET_PREVIEW_MESSAGE = 'This workspace cannot send this file type to a preview.'

/** `files.read` clamps text at the host's cap and reports it; serving the clamped bytes would
 *  render a silently half-finished document. */
const TRUNCATED_PREVIEW_MESSAGE = 'This document is too large for the server to send in full.'

/** The paired host rejects an over-cap asset outright instead of clamping it. */
const RUNTIME_TOO_LARGE_ERROR = 'file_too_large'

/** Both owners refuse an over-cap file; only their error shapes differ. */
function isTooLargeReadError(error: unknown): boolean {
  return (
    error instanceof FileReadCapExceededError ||
    (error instanceof Error && error.message === RUNTIME_TOO_LARGE_ERROR)
  )
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
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf'
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
  /** Set by every owner that agreed to serve the bytes, so it also survives a 0-byte file. */
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
  // Why: an empty binary body is two different answers. A host that still named the file's type
  // read a 0-byte file, and 0 bytes is what it should serve; a host that named no type declined
  // the format outright and has nothing to send.
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
  relativePath: string
): Promise<PreviewFileBytes> {
  const userDataPath = getCanonicalUserDataPath()
  const response = await callRuntimeEnvironment(
    userDataPath,
    environmentId,
    'files.read',
    { worktree: worktreeSelector, relativePath },
    DOC_PREVIEW_READ_TIMEOUT_MS
  )
  if (response.ok) {
    const result = response.result as RuntimeFileReadResult
    return { content: result.content, isBinary: false, truncated: result.truncated === true }
  }
  // Why: files.read rejects binaries with a typed error; the base64 preview RPC serves
  // images and fonts the same way it does for markdown previews. Match the exact
  // message so an unrelated failure can't spoof the fallback.
  if (response.error.message !== 'binary_file') {
    throw new Error(response.error.message)
  }
  const previewResponse = await callRuntimeEnvironment(
    userDataPath,
    environmentId,
    'files.readPreview',
    { worktree: worktreeSelector, relativePath },
    DOC_PREVIEW_READ_TIMEOUT_MS
  )
  if (!previewResponse.ok) {
    throw new Error(previewResponse.error.message)
  }
  const preview = previewResponse.result as RuntimeFilePreviewResult
  // Why: readPreview never clamps — it rejects an over-cap asset — so its body is whole or absent.
  return {
    content: preview.content,
    isBinary: preview.isBinary,
    ...(preview.mimeType ? { mimeType: preview.mimeType } : {})
  }
}

function notFoundOutcome(message = 'Not found'): DocPreviewReadOutcome {
  return { ok: false, status: 404, reason: 'unreadable', message }
}

/** Reads one in-grant path over the same channel the editor uses for that owner. */
export async function readDocPreviewFile(
  grant: DocPreviewGrant,
  relativePath: string
): Promise<DocPreviewReadOutcome> {
  const absolutePath = resolveDocPreviewTargetPath(grant, relativePath)
  if (!absolutePath) {
    return notFoundOutcome()
  }
  const contentType = docPreviewContentType(relativePath)
  try {
    if (grant.owner.kind === 'ssh') {
      const provider = requireSshFilesystemProvider(grant.owner.connectionId)
      // Why: the SSH read RPC enforces no root of its own, so containment has to survive a symlink
      // before the read — the lexical check above only proves the requested path looked contained.
      const canonicalPath = await resolveCanonicalDocPreviewPath(grant, absolutePath, (path) =>
        provider.realpath(path)
      )
      if (!canonicalPath) {
        return notFoundOutcome()
      }
      // Why: the SSH reader rejects an over-cap file outright, so its result is never partial.
      return toOutcome(await provider.readFile(canonicalPath), contentType)
    }
    const worktreeRelativePath = toRuntimeWorktreeRelativePath(
      grant.owner.worktreeRoot,
      absolutePath
    )
    if (!worktreeRelativePath) {
      // Why: files.read is worktree-scoped, so a doc outside the worktree has no client-side channel.
      return notFoundOutcome()
    }
    // Why no realpath pass here: the host resolves this path through resolveAuthorizedPath, which
    // canonicalizes and re-checks the worktree root server-side before reading.
    return toOutcome(
      await readRuntimeDocPreviewFile(
        grant.owner.environmentId,
        grant.owner.worktreeSelector,
        worktreeRelativePath
      ),
      contentType
    )
  } catch (error) {
    return isTooLargeReadError(error)
      ? { ok: false, status: 413, reason: 'too-large', message: TRUNCATED_PREVIEW_MESSAGE }
      : notFoundOutcome(error instanceof Error ? error.message : undefined)
  }
}
