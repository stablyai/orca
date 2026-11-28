import { isAscii, isUtf8 } from 'node:buffer'
import { readFile, stat } from 'node:fs/promises'
import type { GitDiffEncoding } from '../../../../shared/git/diff/git-diff-compare-types'
import { isBinaryBuffer } from '../../../../shared/file-preview/binary-buffer'
import { isMissingGitBlobPath } from '../../../../shared/git/diff/git-blob-absence'
import { readGitCommandFailureStderr } from '../../../../shared/git/commands/git-command-failure-text'

import {
  type GitRuntimeOptions,
  type GitDiffReadOptions,
  gitReadOptionsForWorktree
} from '../../command-runner/git-runtime-options'
import { gitExecFileAsyncBuffer } from '../../command-runner/git-exec-file'
import { isMaxBufferOverflowError } from '../../command-runner/process-capture/max-buffer-overflow'
import { MAX_GIT_SHOW_BYTES } from '../git-show-max-bytes'
import { literalPathspec } from '../git-pathspec'
import {
  type DiffAttributes,
  readDiffAttributes,
  readBlobStoresUtf8,
  isImageOrPdfPreviewPath
} from './textconv-driver'

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
export type BlobConversion = { mode: 'textconv' | 'checkout'; attributes: Promise<DiffAttributes> }

/** Share one attribute lookup between both sides of a diff. */
export function blobConversion(
  worktreePath: string,
  filePath: string,
  options: GitDiffReadOptions,
  mode: BlobConversion['mode'] = 'textconv'
): BlobConversion {
  return { mode, attributes: readDiffAttributes(worktreePath, filePath, options) }
}

export async function readUnstagedLeftBlob(
  worktreePath: string,
  filePath: string,
  options: GitDiffReadOptions = {},
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
  options: GitDiffReadOptions = {},
  conversion?: BlobConversion
): Promise<GitBlobReadResult> {
  return readGitBlob(worktreePath, undefined, filePath, options, conversion)
}

export function readGitBlobAtOidPath(
  worktreePath: string,
  oid: string,
  filePath: string,
  options: GitDiffReadOptions = {},
  conversion?: BlobConversion
): Promise<GitBlobReadResult> {
  return readGitBlob(worktreePath, oid, filePath, options, conversion)
}

async function readGitBlob(
  worktreePath: string,
  oid: string | undefined,
  filePath: string,
  options: GitDiffReadOptions,
  conversion: BlobConversion | undefined
): Promise<GitBlobReadResult> {
  // Git blob syntax requires forward slashes, including on Windows.
  const gitPath = filePath.replace(/\\/g, '/')
  const spec = `${oid ?? ''}:${gitPath}`
  const readOptions = {
    ...gitReadOptionsForWorktree(worktreePath, options),
    maxBuffer: MAX_GIT_SHOW_BYTES
  }
  const { mode, attributes } = conversion ?? blobConversion(worktreePath, filePath, options)
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
  const { hasTextconv, storesUtf8 } = await attributes
  let rawEncoding = options.encoding
  if (rawEncoding === 'gb18030' && !isAscii(raw) && isUtf8(raw)) {
    const normalized = (await readBlobStoresUtf8(worktreePath, gitPath, oid, options)) ?? storesUtf8
    if (normalized) {
      rawEncoding = 'utf-8'
    }
  }
  if (!hasTextconv) {
    return bufferToBlob(raw, filePath, rawEncoding)
  }
  try {
    const { stdout } = await gitExecFileAsyncBuffer(
      ['cat-file', mode === 'checkout' ? '--filters' : '--textconv', '--', spec],
      readOptions
    )
    if (mode === 'textconv' && options.encoding === 'gb18030') {
      if (stdout.equals(raw)) {
        return bufferToBlob(raw, filePath, rawEncoding)
      }
      if (!isBinaryBuffer(stdout) && isUtf8(stdout)) {
        return {
          content: decodeChangedTextconvOutput(raw, stdout, rawEncoding === 'utf-8'),
          isBinary: false,
          exists: true
        }
      }
    }
    return bufferToBlob(stdout, filePath, options.encoding)
  } catch (error) {
    if (isMaxBufferOverflowError(error)) {
      return TOO_LARGE_BLOB
    }
    // A driver or filter missing from this host's PATH, or failing, must not hide the stored blob.
    return bufferToBlob(raw, filePath, rawEncoding)
  }
}

function decodeChangedTextconvOutput(raw: Buffer, output: Buffer, rawIsUtf8: boolean): string {
  const utf8 = output.toString('utf8')
  const gb18030 = tryDecodeGb18030(output)
  if (gb18030 === undefined || gb18030 === utf8) {
    return utf8
  }
  const original = rawIsUtf8 ? raw.toString('utf8') : tryDecodeGb18030(raw)
  return original !== undefined && sameTextIgnoringCrlf(original, utf8) ? utf8 : gb18030
}

// A driver can transcode and normalize line endings in one pass. Compare without copying either diff.
function sameTextIgnoringCrlf(left: string, right: string): boolean {
  if (left === right) {
    return true
  }
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    if (left.startsWith('\r\n', i)) {
      i++
    }
    if (right.startsWith('\r\n', j)) {
      j++
    }
    if (left[i] !== right[j]) {
      return false
    }
    i++
    j++
  }
  return i === left.length && j === right.length
}

function tryDecodeGb18030(bytes: Buffer): string | undefined {
  try {
    return new TextDecoder('gb18030', { fatal: true }).decode(bytes)
  } catch {
    return undefined
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

export async function readWorkingTreeFile(
  filePath: string,
  encoding?: GitDiffEncoding
): Promise<GitBlobReadResult> {
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
    return bufferToBlob(buffer, filePath, encoding)
  } catch {
    return { content: '', isBinary: false, exists: true, failed: true }
  }
}

function bufferToBlob(
  buffer: Buffer,
  filePath: string,
  encoding?: GitDiffEncoding
): GitBlobReadResult {
  if (isBinaryBuffer(buffer)) {
    const content = isImageOrPdfPreviewPath(filePath) ? buffer.toString('base64') : ''
    return { content, isBinary: true, exists: true }
  }
  const content =
    encoding === 'gb18030' ? new TextDecoder(encoding).decode(buffer) : buffer.toString('utf8')
  return { content, isBinary: false, exists: true }
}
