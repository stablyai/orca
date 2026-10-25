import { dirname, extname, isAbsolute, resolve } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import type { Store } from '../persistence'
import type { LocalFileAccess } from '../../shared/local-file-access'
import {
  PATH_ACCESS_DENIED_MESSAGE,
  resolveAuthorizedPath,
  type ResolveAuthorizedPathOptions
} from './filesystem/filesystem-auth'
import { isDescendantOrEqual } from './filesystem/filesystem-path-containment'
import { PREVIEWABLE_BINARY_MIME_TYPES } from './filesystem/filesystem-file-content-inspection'
import { getDefaultFloatingWorkspacePath } from './floating-workspace-directory'
import {
  isDeviceNamespacePath,
  isNetworkSharePath,
  isWindowsReservedDeviceName
} from './automatic-load-path-text'
import { NOT_A_REGULAR_FILE_MESSAGE } from './filesystem/local-regular-file-read'

const USER_FILE_NEEDS_ABSOLUTE_PATH_MESSAGE =
  'Access denied: a file opened by name needs an absolute path.'
const USER_FILE_ACCESS: LocalFileAccess = { kind: 'user-file' }

const CHAT_IMAGE_TYPE_MESSAGE = 'Access denied: a chat can only show local image files.'

export async function resolveDesktopAuthorizedPath(
  targetPath: string,
  store: Store,
  options: ResolveAuthorizedPathOptions = {}
): Promise<string> {
  return resolveAuthorizedPath(targetPath, store, {
    ...options,
    extraRoots: [getDefaultFloatingWorkspacePath()]
  })
}

/** User-named absolute paths require no root and grant no persistent access. */
function resolveUserNamedLocalPath(targetPath: string): string {
  // Reject raw relative and drive-relative paths before resolve can anchor them to main's cwd.
  if (typeof targetPath !== 'string' || !isAbsolute(targetPath)) {
    throw new Error(USER_FILE_NEEDS_ABSOLUTE_PATH_MESSAGE)
  }
  return resolve(targetPath)
}

/** Require an existing regular user-named file; project paths retain normal canonicalization. */
export async function resolveUserNamedRegularFile(
  targetPath: string,
  store: Store
): Promise<string> {
  const filePath = await resolveLocalRequestPath(targetPath, USER_FILE_ACCESS, store, 'read')
  if (!(await stat(filePath)).isFile()) {
    throw new Error(NOT_A_REGULAR_FILE_MESSAGE)
  }
  return filePath
}

// Chat uses img rendering; PDF previews need a different surface.
function isChatImage(filePath: string): boolean {
  const extension = extname(filePath).toLowerCase()
  return Boolean(PREVIEWABLE_BINARY_MIME_TYPES[extension]) && extension !== '.pdf'
}

// Resolve path text first because devices can hide behind dot and parent segments.
function isRefusedAutomaticLoadPath(filePath: string): boolean {
  return isDeviceNamespacePath(filePath) || isWindowsReservedDeviceName(filePath)
}

/** Allow document-local resources; reject outside-folder or network paths before filesystem access and contain symlink targets. */
async function resolveDocumentResourcePath(
  targetPath: string,
  documentPath: string
): Promise<string> {
  if (
    typeof targetPath !== 'string' ||
    !isAbsolute(targetPath) ||
    typeof documentPath !== 'string' ||
    !isAbsolute(documentPath)
  ) {
    throw new Error(PATH_ACCESS_DENIED_MESSAGE)
  }
  const resolvedTarget = resolve(targetPath)
  if (isRefusedAutomaticLoadPath(resolvedTarget)) {
    throw new Error(PATH_ACCESS_DENIED_MESSAGE)
  }
  const documentFolder = dirname(resolve(documentPath))
  if (isNetworkSharePath(resolvedTarget) || !isDescendantOrEqual(resolvedTarget, documentFolder)) {
    throw new Error(PATH_ACCESS_DENIED_MESSAGE)
  }
  const realTarget = resolve(await realpath(resolvedTarget))
  if (!isDescendantOrEqual(realTarget, resolve(await realpath(documentFolder)))) {
    throw new Error(PATH_ACCESS_DENIED_MESSAGE)
  }
  if (isRefusedAutomaticLoadPath(realTarget)) {
    throw new Error(PATH_ACCESS_DENIED_MESSAGE)
  }
  return realTarget
}

/** Chat accepts absolute images by real target type; network shares are readable only inside registered project roots. */
async function resolveChatImagePath(targetPath: string, store: Store): Promise<string> {
  if (typeof targetPath !== 'string' || !isAbsolute(targetPath)) {
    throw new Error(PATH_ACCESS_DENIED_MESSAGE)
  }
  const resolvedTarget = resolve(targetPath)
  if (isRefusedAutomaticLoadPath(resolvedTarget)) {
    throw new Error(PATH_ACCESS_DENIED_MESSAGE)
  }
  if (isNetworkSharePath(resolvedTarget)) {
    throw new Error(PATH_ACCESS_DENIED_MESSAGE)
  }
  const realTarget = resolve(await realpath(resolvedTarget))
  if (isRefusedAutomaticLoadPath(realTarget)) {
    throw new Error(PATH_ACCESS_DENIED_MESSAGE)
  }
  if (isNetworkSharePath(realTarget) && !isNetworkSharePath(resolvedTarget)) {
    // A local link can resolve onto a share; only registered project roots authorize that target.
    await resolveDesktopAuthorizedPath(realTarget, store)
  }
  // A .png symlink to a secret is not an image.
  if (!isChatImage(realTarget)) {
    throw new Error(CHAT_IMAGE_TYPE_MESSAGE)
  }
  return realTarget
}

/** Writes beside an opened document must remain within its real folder. */
async function resolveDocumentFolderPath(
  targetPath: string,
  documentPath: string
): Promise<string> {
  if (
    typeof targetPath !== 'string' ||
    !isAbsolute(targetPath) ||
    typeof documentPath !== 'string' ||
    !isAbsolute(documentPath)
  ) {
    throw new Error(PATH_ACCESS_DENIED_MESSAGE)
  }
  const resolvedTarget = resolve(targetPath)
  const documentFolder = dirname(resolve(documentPath))
  if (
    isRefusedAutomaticLoadPath(resolvedTarget) ||
    !isDescendantOrEqual(resolvedTarget, documentFolder)
  ) {
    throw new Error(PATH_ACCESS_DENIED_MESSAGE)
  }
  const realTarget = resolve(await realpath(resolvedTarget))
  const realFolder = resolve(await realpath(documentFolder))
  if (isRefusedAutomaticLoadPath(realTarget) || !isDescendantOrEqual(realTarget, realFolder)) {
    throw new Error(PATH_ACCESS_DENIED_MESSAGE)
  }
  return realTarget
}

function isOpenedDocument(targetPath: unknown, documentPath: string): boolean {
  return (
    typeof targetPath === 'string' &&
    isAbsolute(targetPath) &&
    isAbsolute(documentPath) &&
    resolve(targetPath) === resolve(documentPath)
  )
}

// Unknown IPC access kinds fall back to ordinary project-root authorization.
function parseLocalFileAccess(access: unknown): LocalFileAccess | undefined {
  if (typeof access !== 'object' || access === null || !('kind' in access)) {
    return undefined
  }
  if (access.kind === 'user-file') {
    return { kind: 'user-file' }
  }
  if (access.kind === 'chat-image') {
    return { kind: 'chat-image' }
  }
  if (
    access.kind === 'document-folder' &&
    'documentPath' in access &&
    typeof access.documentPath === 'string'
  ) {
    return { kind: 'document-folder', documentPath: access.documentPath }
  }
  if (
    access.kind === 'document-resource' &&
    'documentPath' in access &&
    typeof access.documentPath === 'string'
  ) {
    return { kind: 'document-resource', documentPath: access.documentPath }
  }
  return undefined
}

export type LocalRequestOperation = 'read' | 'write' | 'rename-from' | 'rename-to' | 'import-into'

type KindRule = (targetPath: string) => Promise<string>

function declaredKindRule(
  fileAccess: LocalFileAccess,
  operation: LocalRequestOperation,
  store: Store
): KindRule | undefined {
  switch (fileAccess.kind) {
    case 'user-file':
      // Only the opened document itself receives this rename access.
      return operation !== 'import-into'
        ? async (targetPath) => resolveUserNamedLocalPath(targetPath)
        : undefined
    case 'document-resource':
      return operation === 'read'
        ? (targetPath) => resolveDocumentResourcePath(targetPath, fileAccess.documentPath)
        : undefined
    case 'chat-image':
      return operation === 'read'
        ? (targetPath) => resolveChatImagePath(targetPath, store)
        : undefined
    case 'document-folder':
      return operation === 'import-into'
        ? (targetPath) => resolveDocumentFolderPath(targetPath, fileAccess.documentPath)
        : undefined
  }
}

/** Declared access adds paths beyond project roots without refusing paths the default check allows. */
export async function resolveLocalRequestPath(
  targetPath: string,
  access: unknown,
  store: Store,
  operation: LocalRequestOperation
): Promise<string> {
  // Rename operates on link entries, not their resolved targets.
  const options = { preserveSymlink: operation === 'rename-from' || operation === 'rename-to' }
  const fileAccess = parseLocalFileAccess(access)
  const kindRule = fileAccess && declaredKindRule(fileAccess, operation, store)
  if (!fileAccess || !kindRule) {
    return resolveDesktopAuthorizedPath(targetPath, store, options)
  }
  if (typeof targetPath !== 'string') {
    throw new Error(PATH_ACCESS_DENIED_MESSAGE)
  }
  // Device names must be refused before any automatic load, even inside projects.
  const automaticLoad = fileAccess.kind === 'document-resource' || fileAccess.kind === 'chat-image'
  if (automaticLoad && isRefusedAutomaticLoadPath(resolve(targetPath))) {
    throw new Error(PATH_ACCESS_DENIED_MESSAGE)
  }
  // The default textual root check refuses outside paths without contacting shares.
  const insideRoots = await resolveDesktopAuthorizedPath(targetPath, store, options).catch(
    () => undefined
  )
  if (insideRoots === undefined) {
    return kindRule(targetPath)
  }
  if (automaticLoad && isRefusedAutomaticLoadPath(insideRoots)) {
    throw new Error(PATH_ACCESS_DENIED_MESSAGE)
  }
  return insideRoots
}

/** Opened documents may rename anywhere and undo from there; other renames keep ordinary root checks. */
export async function resolveLocalRenamePaths(
  oldPath: string,
  newPath: string,
  access: unknown,
  store: Store
): Promise<{ from: string; to: string }> {
  const fileAccess = parseLocalFileAccess(access)
  const renameAccess =
    fileAccess?.kind === 'document-folder' && isOpenedDocument(oldPath, fileAccess.documentPath)
      ? USER_FILE_ACCESS
      : undefined
  return {
    from: await resolveLocalRequestPath(oldPath, renameAccess, store, 'rename-from'),
    to: await resolveLocalRequestPath(newPath, renameAccess, store, 'rename-to')
  }
}

export function resolveLocalFileRequestPath(
  targetPath: string,
  access: unknown,
  store: Store
): Promise<string> {
  return resolveLocalRequestPath(targetPath, access, store, 'read')
}

export function resolveLocalWriteRequestPath(
  targetPath: string,
  access: unknown,
  store: Store
): Promise<string> {
  return resolveLocalRequestPath(targetPath, access, store, 'write')
}
