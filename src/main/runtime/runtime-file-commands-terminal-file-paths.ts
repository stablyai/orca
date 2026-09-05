// @ts-nocheck -- mechanically split declarations.
import { lstat, open, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { isENOENT } from '../ipc/filesystem-path-containment'
import type { Store } from '../persistence'
import { resolveAuthorizedPath } from '../ipc/filesystem-auth'
import type { TerminalFileGrant } from './runtime-file-commands-mobile-file-list-limit'
import {
  LOCAL_PREVIEWABLE_BINARY_MAX_BYTES,
  MOBILE_FILE_READ_MAX_BYTES,
  OPEN_NOFOLLOW,
  RUNTIME_PREVIEWABLE_BINARY_MIME_TYPES,
  previewableBinaryByteLimit
} from './runtime-file-commands-mobile-file-list-limit'
import type { FileHandle } from 'node:fs/promises'
import {
  assertTerminalFileGrantFresh,
  canonicalPathForArtifactComparison,
  localTerminalArtifactRoots,
  readFileHandleBufferBounded
} from './runtime-file-commands-terminal-artifact-access'
import { isBinaryBuffer } from './runtime-file-command-host'
import type { RuntimeFilePreviewResult } from '../../shared/runtime-types'
import {
  isPathInsideOrEqual,
  isRuntimePathAbsolute,
  isWindowsAbsolutePathLike,
  resolveRuntimePath
} from '../../shared/cross-platform-path'
import { parseWslPath, toWindowsWslPath } from '../wsl'

export async function assertRuntimePathDoesNotExist(targetPath: string): Promise<void> {
  try {
    await lstat(targetPath)
    throw new Error(
      `A file or folder named '${basename(targetPath)}' already exists in this location`
    )
  } catch (error) {
    if (!isENOENT(error)) {
      throw error
    }
  }
}

export function rethrowRuntimeFileCreateError(error: unknown, targetPath: string): never {
  const name = basename(targetPath)
  if (error instanceof Error && 'code' in error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') {
      throw new Error(`A file or folder named '${name}' already exists in this location`)
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new Error(`Permission denied: unable to create '${name}'`)
    }
  }
  throw error
}

export async function readLocalMobileFile(filePath: string, store: Store): Promise<string> {
  const authorizedPath = await resolveAuthorizedPath(filePath, store)
  const fileStat = await stat(authorizedPath)
  // Why: cap the read so opening a large file can't block the WebSocket (previews are read-only convenience views).
  const readLimit = Math.min(fileStat.size, MOBILE_FILE_READ_MAX_BYTES + 1)
  const handle = await open(authorizedPath, 'r')
  try {
    const buffer = Buffer.alloc(readLimit)
    const { bytesRead } = await handle.read(buffer, 0, readLimit, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

export async function readLocalTerminalArtifactFileFromHandle(
  handle: FileHandle,
  grant: TerminalFileGrant
): Promise<string> {
  const fileStat = await handle.stat()
  if (fileStat.isDirectory()) {
    throw new Error('Cannot read a directory')
  }
  if (fileStat.size > MOBILE_FILE_READ_MAX_BYTES) {
    throw new Error('file_too_large')
  }
  assertTerminalFileGrantFresh(grant, fileStat)
  const buffer = await readFileHandleBufferBounded(handle, MOBILE_FILE_READ_MAX_BYTES + 1)
  if (isBinaryBuffer(buffer)) {
    throw new Error('binary_file')
  }
  return buffer.toString('utf8')
}

export async function readLocalTerminalArtifactPreviewFromHandle(
  handle: FileHandle,
  grant: TerminalFileGrant,
  maxContentBytes: number | undefined
): Promise<RuntimeFilePreviewResult> {
  const fileStats = await handle.stat()
  if (fileStats.isDirectory()) {
    throw new Error('Cannot preview a directory')
  }
  assertTerminalFileGrantFresh(grant, fileStats)
  const mimeType = RUNTIME_PREVIEWABLE_BINARY_MIME_TYPES[extname(grant.absolutePath).toLowerCase()]
  if (mimeType) {
    const binaryMaxBytes =
      maxContentBytes === undefined
        ? LOCAL_PREVIEWABLE_BINARY_MAX_BYTES
        : previewableBinaryByteLimit(maxContentBytes)
    if (fileStats.size > binaryMaxBytes) {
      throw new Error('file_too_large')
    }
    const buffer = await readFileHandleBufferBounded(handle, binaryMaxBytes + 1)
    if (buffer.byteLength > binaryMaxBytes) {
      throw new Error('file_too_large')
    }
    return {
      content: buffer.toString('base64'),
      isBinary: true,
      isImage: true,
      mimeType
    }
  }

  const content = await readLocalTerminalArtifactFileFromHandle(handle, grant)
  return { content, isBinary: false }
}

export async function assertLocalTerminalArtifactPathStillCanonical(
  filePath: string
): Promise<void> {
  const currentPath = await canonicalPathForArtifactComparison(filePath)
  if (currentPath !== filePath) {
    throw new Error('terminal_file_grant_stale')
  }
}

export async function openLocalTerminalArtifactGrant(
  grant: TerminalFileGrant,
  flags: number
): Promise<FileHandle> {
  await assertLocalTerminalArtifactPathStillCanonical(grant.absolutePath)
  try {
    return await open(grant.absolutePath, flags | OPEN_NOFOLLOW)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error('terminal_file_grant_stale')
    }
    throw error
  }
}

export function resolveTerminalAbsolutePath(args: {
  base: string
  expanded: string
  worktreePath: string
  connectionId?: string
  terminalFileUriHostname?: string | null
}): string {
  const expanded = normalizeTerminalFileUriAuthorityPath(
    args.expanded,
    args.connectionId,
    args.terminalFileUriHostname,
    args.worktreePath
  )
  const absolutePath = isRuntimePathAbsolute(expanded)
    ? expanded
    : resolveRuntimePath(args.base, expanded)
  if (args.connectionId) {
    return normalizeLeadingSlashDrivePath(absolutePath, args.worktreePath)
  }
  const wsl = parseWslPath(args.worktreePath)
  if (wsl && absolutePath.startsWith('/') && !absolutePath.startsWith('//')) {
    return toWindowsWslPath(absolutePath, wsl.distro)
  }
  return absolutePath
}

export function normalizeTerminalFileUriAuthorityPath(
  pathText: string,
  connectionId?: string,
  terminalFileUriHostname?: string | null,
  worktreePath?: string
): string {
  if (!pathText.startsWith('//')) {
    return pathText
  }
  const match = /^\/\/([^/\\]+)([/\\].*)$/.exec(pathText)
  if (!match) {
    return pathText
  }
  const host = match[1]!.toLowerCase()
  if (terminalFileUriHostname && host === terminalFileUriHostname.toLowerCase() && connectionId) {
    return normalizeLeadingSlashDrivePath(match[2]!, worktreePath)
  }
  if (isLoopbackFileUriHostname(host) && (connectionId || process.platform !== 'win32')) {
    return normalizeLeadingSlashDrivePath(match[2]!, worktreePath)
  }
  // Why: without a verified host match, stripping the file-URI authority could open a same-path artifact on the wrong machine.
  return pathText
}

export function provenancePathCandidate(pathText: string, absolutePath: string): string {
  return pathText.startsWith('//') ? pathText : absolutePath
}

export function isLoopbackFileUriHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

export function normalizeLeadingSlashDrivePath(pathText: string, worktreePath?: string): string {
  return worktreePath &&
    isWindowsAbsolutePathLike(worktreePath) &&
    /^\/[A-Za-z]:[\\/]/.test(pathText)
    ? pathText.slice(1)
    : pathText
}

export async function resolveAllowedLocalTerminalArtifactPath(
  absolutePath: string,
  worktreePath: string
): Promise<string | null> {
  const roots = await localTerminalArtifactRoots(worktreePath)
  const canonicalPath = await canonicalPathForArtifactComparison(absolutePath)
  return roots.some((root) => isPathInsideOrEqual(root, canonicalPath)) ? canonicalPath : null
}
