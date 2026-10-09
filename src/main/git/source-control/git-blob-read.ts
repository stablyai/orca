import { readFile, stat } from 'node:fs/promises'
import * as path from 'node:path'
import { isBinaryBuffer } from '../../../shared/binary-buffer'
import { resolveGitLfsPreview } from '../../../shared/git-lfs-preview'
import { probeGitBlobPresence } from '../../../shared/git-blob-presence'
import { isMissingGitBlobPath } from '../../../shared/git-blob-absence'
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
  unmerged?: boolean
  /**
   * Content could not be read, even if the blob exists; callers must not cache this diff.
   */
  failed?: boolean
}

async function readFilteredBlobFailure(
  worktreePath: string,
  gitPath: string,
  options: GitRuntimeOptions,
  oid?: string
): Promise<GitBlobReadResult> {
  const present = await probeGitBlobPresence(
    async (args) =>
      (await gitExecFileAsyncBuffer(args, gitReadOptionsForWorktree(worktreePath, options))).stdout,
    gitPath,
    oid
  )
  return {
    content: '',
    isBinary: present !== false,
    exists: present !== false,
    failed: present !== false,
    ...(present === 'unmerged' ? { unmerged: true } : {})
  }
}

export async function readUnstagedLeftBlob(
  worktreePath: string,
  filePath: string,
  options: GitRuntimeOptions = {}
): Promise<GitBlobReadResult> {
  const indexBlob = await readGitBlobAtIndexPath(worktreePath, filePath, options)
  if (!indexBlob.unmerged && (indexBlob.exists || indexBlob.failed)) {
    return indexBlob
  }

  const headBlob = await readGitBlobAtOidPath(worktreePath, 'HEAD', filePath, options)
  return indexBlob.failed ? { ...headBlob, failed: true } : headBlob
}

export async function readGitBlobAtIndexPath(
  worktreePath: string,
  filePath: string,
  options: GitRuntimeOptions = {}
): Promise<GitBlobReadResult> {
  // Why: Git's `:<path>` syntax expects forward slashes even on Windows.
  const gitPath = filePath.replace(/\\/g, '/')
  // preview bytes must resolve LFS pointers using the host's smudge filter
  const command = PREVIEWABLE_BINARY_MIME_TYPES[path.extname(filePath).toLowerCase()]
    ? ['cat-file', '--filters', '--']
    : ['show']
  try {
    const { stdout } = await gitExecFileAsyncBuffer([...command, `:${gitPath}`], {
      ...gitReadOptionsForWorktree(worktreePath, options),
      maxBuffer: MAX_GIT_SHOW_BYTES
    })

    const content = PREVIEWABLE_BINARY_MIME_TYPES[path.extname(filePath).toLowerCase()]
      ? await resolveGitLfsPreview(
          stdout,
          gitPath,
          async (args, stdin) =>
            (
              await gitExecFileAsyncBuffer(args, {
                ...gitReadOptionsForWorktree(worktreePath, options),
                maxBuffer: MAX_GIT_SHOW_BYTES,
                stdin
              })
            ).stdout
        )
      : stdout
    return { ...bufferToBlob(content, filePath), exists: true }
  } catch (error) {
    if (isMaxBufferOverflowError(error)) {
      return { content: '', isBinary: true, exists: true }
    }
    if (PREVIEWABLE_BINARY_MIME_TYPES[path.extname(filePath).toLowerCase()]) {
      return readFilteredBlobFailure(worktreePath, gitPath, options)
    }
    return {
      content: '',
      isBinary: false,
      exists: false,
      failed: !isMissingGitBlobPath(error, gitPath)
    }
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
  // preview bytes must resolve LFS pointers using the host's smudge filter
  const command = PREVIEWABLE_BINARY_MIME_TYPES[path.extname(filePath).toLowerCase()]
    ? ['cat-file', '--filters', '--']
    : ['show', '--end-of-options']
  try {
    const { stdout } = await gitExecFileAsyncBuffer([...command, `${oid}:${gitPath}`], {
      ...gitReadOptionsForWorktree(worktreePath, options),
      maxBuffer: MAX_GIT_SHOW_BYTES
    })

    const content = PREVIEWABLE_BINARY_MIME_TYPES[path.extname(filePath).toLowerCase()]
      ? await resolveGitLfsPreview(
          stdout,
          gitPath,
          async (args, stdin) =>
            (
              await gitExecFileAsyncBuffer(args, {
                ...gitReadOptionsForWorktree(worktreePath, options),
                maxBuffer: MAX_GIT_SHOW_BYTES,
                stdin
              })
            ).stdout
        )
      : stdout
    return { ...bufferToBlob(content, filePath), exists: true }
  } catch (error) {
    if (isMaxBufferOverflowError(error)) {
      return { content: '', isBinary: true, exists: true }
    }
    if (PREVIEWABLE_BINARY_MIME_TYPES[path.extname(filePath).toLowerCase()]) {
      return readFilteredBlobFailure(worktreePath, gitPath, options, oid)
    }
    return {
      content: '',
      isBinary: false,
      exists: false,
      failed: !isMissingGitBlobPath(error, gitPath, oid)
    }
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
