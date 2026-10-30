import { readFile, stat } from 'node:fs/promises'
import { isBinaryBuffer } from '../../../shared/binary-buffer'
import { isMissingGitBlobPath } from '../../../shared/git-blob-absence'
import { readGitCommandFailureStderr } from '../../../shared/git-command-failure-text'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitReadOptionsForWorktree } from '../git-runtime-options'
import { gitExecFileAsyncBuffer } from '../runner'
import { isMaxBufferOverflowError } from '../max-buffer-overflow'
import { MAX_GIT_SHOW_BYTES } from './git-show-max-bytes'
import {
  IMAGE_AND_PDF_PREVIEW_MIME_TYPES,
  filePreviewExtension
} from '../../../shared/file-preview-kind'
import { literalPathspec } from './git-pathspec'

export type GitBlobReadResult = {
  content: string
  isBinary: boolean
  exists: boolean
  /** Unknown presence: never cache a diff whose empty side came from an incomplete read. */
  failed?: boolean
  /** Past MAX_GIT_SHOW_BYTES: left unread and reported binary, so older diff readers stay safe. */
  tooLarge?: boolean
}

const TOO_LARGE_BLOB: GitBlobReadResult = {
  content: '',
  isBinary: true,
  exists: true,
  tooLarge: true
}

export async function readUnstagedLeftBlob(
  worktreePath: string,
  filePath: string,
  options: GitRuntimeOptions = {}
): Promise<GitBlobReadResult> {
  const indexBlob = await readGitBlobAtIndexPath(worktreePath, filePath, options)
  if (indexBlob.exists || indexBlob.failed) {
    return indexBlob
  }

  return readGitBlobAtOidPath(worktreePath, 'HEAD', filePath, options)
}

export async function readGitBlobAtIndexPath(
  worktreePath: string,
  filePath: string,
  options: GitRuntimeOptions = {}
): Promise<GitBlobReadResult> {
  // Git blob syntax requires forward slashes, including on Windows.
  const gitPath = filePath.replace(/\\/g, '/')
  try {
    const { stdout } = await gitExecFileAsyncBuffer(['cat-file', 'blob', '--', `:${gitPath}`], {
      ...gitReadOptionsForWorktree(worktreePath, options),
      maxBuffer: MAX_GIT_SHOW_BYTES
    })

    return { ...bufferToBlob(stdout, filePath), exists: true }
  } catch (error) {
    if (isMaxBufferOverflowError(error)) {
      return TOO_LARGE_BLOB
    }
    return {
      content: '',
      isBinary: false,
      exists: false,
      failed: !(await verifyMissingBlobPath(error, worktreePath, gitPath, options))
    }
  }
}

export async function readGitBlobAtOidPath(
  worktreePath: string,
  oid: string,
  filePath: string,
  options: GitRuntimeOptions = {}
): Promise<GitBlobReadResult> {
  // Git blob syntax requires forward slashes, including on Windows.
  const gitPath = filePath.replace(/\\/g, '/')
  try {
    const { stdout } = await gitExecFileAsyncBuffer(
      ['cat-file', 'blob', '--', `${oid}:${gitPath}`],
      {
        ...gitReadOptionsForWorktree(worktreePath, options),
        maxBuffer: MAX_GIT_SHOW_BYTES
      }
    )

    return { ...bufferToBlob(stdout, filePath), exists: true }
  } catch (error) {
    if (isMaxBufferOverflowError(error)) {
      return TOO_LARGE_BLOB
    }
    return {
      content: '',
      isBinary: false,
      exists: false,
      failed: !(await verifyMissingBlobPath(error, worktreePath, gitPath, options, oid))
    }
  }
}

async function verifyMissingBlobPath(
  error: unknown,
  worktreePath: string,
  gitPath: string,
  options: GitRuntimeOptions,
  oid?: string
): Promise<boolean> {
  if (isMissingGitBlobPath(error, gitPath, oid)) {
    return true
  }
  if (
    typeof error !== 'object' ||
    error === null ||
    !('code' in error) ||
    error.code !== 128 ||
    readGitCommandFailureStderr(error)?.replace(/\r?\n$/, '') !==
      `fatal: Not a valid object name ${oid ?? ''}:${gitPath}` ||
    oid?.startsWith('-') ||
    options.signal?.aborted
  ) {
    return false
  }
  // Older cat-file omits path diagnostics; only an empty successful listing proves absence.
  try {
    const { stdout } = await gitExecFileAsyncBuffer(
      oid === undefined
        ? ['ls-files', '--stage', '-z', '--', literalPathspec(gitPath, worktreePath, options)]
        : ['ls-tree', '-z', oid, '--', literalPathspec(gitPath, worktreePath, options)],
      { ...gitReadOptionsForWorktree(worktreePath, options), maxBuffer: MAX_GIT_SHOW_BYTES }
    )
    return stdout.length === 0
  } catch {
    return false
  }
}

export async function readWorkingTreeFile(filePath: string): Promise<GitBlobReadResult> {
  let fileStat
  try {
    fileStat = await stat(filePath)
  } catch (error) {
    // Only ENOENT proves deletion; other stat errors leave presence unknown.
    const missing = (error as NodeJS.ErrnoException)?.code === 'ENOENT'
    return { content: '', isBinary: false, exists: !missing, ...(missing ? {} : { failed: true }) }
  }
  if (!fileStat.isFile()) {
    return { content: '', isBinary: false, exists: false }
  }
  if (fileStat.size > MAX_GIT_SHOW_BYTES) {
    // Mirror the Git buffer cap so filesystem reads cannot load huge assets.
    return TOO_LARGE_BLOB
  }
  try {
    const buffer = await readFile(filePath)
    return bufferToBlob(buffer, filePath)
  } catch {
    return { content: '', isBinary: false, exists: true, failed: true }
  }
}

function bufferToBlob(buffer: Buffer, filePath?: string): GitBlobReadResult {
  const isBinary = isBinaryBuffer(buffer)
  // Encode previewable binaries for the renderer.
  const isPreviewableBinary = filePath
    ? !!IMAGE_AND_PDF_PREVIEW_MIME_TYPES[filePreviewExtension(filePath)]
    : false
  return {
    content: isBinary
      ? isPreviewableBinary
        ? buffer.toString('base64')
        : ''
      : buffer.toString('utf-8'),
    isBinary,
    exists: true
  }
}
