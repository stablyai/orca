import { readFile, stat } from 'node:fs/promises'
import * as path from 'node:path'
import { isBinaryBuffer } from '../../../shared/binary-buffer'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitReadOptionsForWorktree } from '../git-runtime-options'
import { gitExecFileAsyncBuffer } from '../runner'
import { isMaxBufferOverflowError } from '../max-buffer-overflow'
import { MAX_GIT_SHOW_BYTES } from './git-show-max-bytes'
import { PREVIEWABLE_BINARY_MIME_TYPES } from './previewable-binary-mime-types'

export type GitBlobReadResult = {
  content: string
  isBinary: boolean
  exists: boolean
  /**
   * The read did not complete: the blob is neither known-present nor proven
   * absent. Callers must not persist a diff built on one, because the empty side
   * it produces is indistinguishable from a genuinely new file.
   */
  failed?: boolean
}

/**
 * Tell "Git ran and said the path is not there" apart from "the read never got
 * an answer". Git exits 128 for a missing path in a tree or the index; a WSL
 * relay that never reached Git exits with anything else, or with a spawn errno.
 */
function isProvenAbsentError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 128
}

export async function readUnstagedLeftBlob(
  worktreePath: string,
  filePath: string,
  options: GitRuntimeOptions = {}
): Promise<GitBlobReadResult> {
  const indexBlob = await readGitBlobAtIndexPath(worktreePath, filePath, options)
  if (indexBlob.exists) {
    return indexBlob
  }

  const headBlob = await readGitBlobAtOidPath(worktreePath, 'HEAD', filePath, options)
  // Why: if the index read never got an answer, falling back to HEAD is a guess, not a proof.
  return indexBlob.failed ? { ...headBlob, failed: true } : headBlob
}

export async function readGitBlobAtIndexPath(
  worktreePath: string,
  filePath: string,
  options: GitRuntimeOptions = {}
): Promise<GitBlobReadResult> {
  // Why: Git's `:<path>` syntax expects forward slashes even on Windows.
  const gitPath = filePath.replace(/\\/g, '/')
  try {
    const { stdout } = await gitExecFileAsyncBuffer(['show', `:${gitPath}`], {
      ...gitReadOptionsForWorktree(worktreePath, options),
      maxBuffer: MAX_GIT_SHOW_BYTES
    })

    return { ...bufferToBlob(stdout, filePath), exists: true }
  } catch (error) {
    if (isMaxBufferOverflowError(error)) {
      return { content: '', isBinary: true, exists: true }
    }
    return { content: '', isBinary: false, exists: false, failed: !isProvenAbsentError(error) }
  }
}

export async function readGitBlobAtOidPath(
  worktreePath: string,
  oid: string,
  filePath: string,
  options: GitRuntimeOptions = {}
): Promise<GitBlobReadResult> {
  // Why: Git's `<oid>:<path>` syntax expects forward slashes even on Windows.
  const gitPath = filePath.replace(/\\/g, '/')
  try {
    const { stdout } = await gitExecFileAsyncBuffer(
      ['show', '--end-of-options', `${oid}:${gitPath}`],
      {
        ...gitReadOptionsForWorktree(worktreePath, options),
        maxBuffer: MAX_GIT_SHOW_BYTES
      }
    )

    return { ...bufferToBlob(stdout, filePath), exists: true }
  } catch (error) {
    if (isMaxBufferOverflowError(error)) {
      return { content: '', isBinary: true, exists: true }
    }
    return { content: '', isBinary: false, exists: false, failed: !isProvenAbsentError(error) }
  }
}

export async function readWorkingTreeFile(filePath: string): Promise<GitBlobReadResult> {
  let fileStat
  try {
    fileStat = await stat(filePath)
  } catch (error) {
    // Why: only ENOENT is a real deletion; other stat errors are read failures, not absence.
    const missing = (error as NodeJS.ErrnoException)?.code === 'ENOENT'
    return { content: '', isBinary: false, exists: !missing, ...(missing ? {} : { failed: true }) }
  }
  if (!fileStat.isFile()) {
    return { content: '', isBinary: false, exists: false }
  }
  if (fileStat.size > MAX_GIT_SHOW_BYTES) {
    // Why: mirror git's maxBuffer cap for working-tree reads so readFile can't pull in huge assets.
    return { content: '', isBinary: true, exists: true }
  }
  try {
    const buffer = await readFile(filePath)
    return bufferToBlob(buffer, filePath)
  } catch {
    // Why: the file exists but could not be read — a read failure, not a deletion.
    return { content: '', isBinary: false, exists: true, failed: true }
  }
}

function bufferToBlob(buffer: Buffer, filePath?: string): GitBlobReadResult {
  const isBinary = isBinaryBuffer(buffer)
  // Return base64 for recognized image formats so the renderer can display them
  const isPreviewableBinary = filePath
    ? !!PREVIEWABLE_BINARY_MIME_TYPES[path.extname(filePath).toLowerCase()]
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
