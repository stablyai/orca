import { readFile, stat } from 'node:fs/promises'
import { isBinaryBuffer } from '../../../shared/binary-buffer'
import { isMissingGitBlobPath } from '../../../shared/git-blob-absence'
import { readGitCommandFailureStderr } from '../../../shared/git-command-failure-text'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitReadOptionsForWorktree } from '../git-runtime-options'
import { gitExecFileAsyncBuffer } from '../runner'
import { isMaxBufferOverflowError } from '../max-buffer-overflow'
import { MAX_GIT_SHOW_BYTES } from './git-show-max-bytes'
import { literalPathspec } from './git-pathspec'
import { hasTextconvDriver, isImageOrPdfPreviewPath } from './textconv-driver'

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

/**
 * How a path with a textconv driver is shown: `textconv` is the text `git diff` shows (read-only
 * sides); `checkout` is what checkout writes, so reverts into an editable side restore real bytes.
 */
export type BlobConversion = { mode: 'textconv' | 'checkout'; hasDriver: Promise<boolean> }

/** Start one driver lookup to share between both sides of a diff. */
export function blobConversion(
  worktreePath: string,
  filePath: string,
  options: GitRuntimeOptions,
  mode: BlobConversion['mode'] = 'textconv'
): BlobConversion {
  return { mode, hasDriver: hasTextconvDriver(worktreePath, filePath, options) }
}

export async function readUnstagedLeftBlob(
  worktreePath: string,
  filePath: string,
  options: GitRuntimeOptions = {},
  conversion?: BlobConversion
): Promise<GitBlobReadResult> {
  const indexBlob = await readGitBlobAtIndexPath(worktreePath, filePath, options, conversion)
  if (indexBlob.exists || indexBlob.failed) {
    return indexBlob
  }

  return readGitBlobAtOidPath(worktreePath, 'HEAD', filePath, options, conversion)
}

/** Omitting `conversion` looks up the path's driver and applies textconv. */
export function readGitBlobAtIndexPath(
  worktreePath: string,
  filePath: string,
  options: GitRuntimeOptions = {},
  conversion?: BlobConversion
): Promise<GitBlobReadResult> {
  return readGitBlob(worktreePath, undefined, filePath, options, conversion)
}

export function readGitBlobAtOidPath(
  worktreePath: string,
  oid: string,
  filePath: string,
  options: GitRuntimeOptions = {},
  conversion?: BlobConversion
): Promise<GitBlobReadResult> {
  return readGitBlob(worktreePath, oid, filePath, options, conversion)
}

async function readGitBlob(
  worktreePath: string,
  oid: string | undefined,
  filePath: string,
  options: GitRuntimeOptions,
  conversion: BlobConversion | undefined
): Promise<GitBlobReadResult> {
  // Git blob syntax requires forward slashes, including on Windows.
  const gitPath = filePath.replace(/\\/g, '/')
  const spec = `${oid ?? ''}:${gitPath}`
  const readOptions = {
    ...gitReadOptionsForWorktree(worktreePath, options),
    maxBuffer: MAX_GIT_SHOW_BYTES
  }
  const { mode, hasDriver } = conversion ?? blobConversion(worktreePath, filePath, options)
  let raw: Buffer
  try {
    // The raw read proves a blob is there: `cat-file --textconv` would print a tree listing.
    raw = (await gitExecFileAsyncBuffer(['cat-file', 'blob', '--', spec], readOptions)).stdout
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
  if (!(await hasDriver)) {
    return { ...bufferToBlob(raw, filePath), exists: true }
  }
  try {
    const { stdout } = await gitExecFileAsyncBuffer(
      ['cat-file', mode === 'checkout' ? '--filters' : '--textconv', '--', spec],
      readOptions
    )
    return { ...bufferToBlob(stdout, filePath), exists: true }
  } catch (error) {
    if (isMaxBufferOverflowError(error)) {
      return TOO_LARGE_BLOB
    }
    // A driver or filter missing from this host's PATH, or failing, must not hide the stored blob.
    return { ...bufferToBlob(raw, filePath), exists: true }
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
  const isPreviewableBinary = filePath ? isImageOrPdfPreviewPath(filePath) : false
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
