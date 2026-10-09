import * as path from 'node:path'
import { resolveGitLfsPreview } from '../shared/git-lfs-preview'
import { probeGitBlobPresence } from '../shared/git-blob-presence'
import { isMissingGitBlobPath } from '../shared/git-blob-absence'
import { bufferToBlob, PREVIEWABLE_MIME } from './git-handler-utils'
import { isGitBufferOverflowError, isGitReadInterruptedError } from './git-buffer-overflow'
import type { GitBufferExec } from './git-handler-ops'

export async function readBlobAtOid(
  gitBuffer: GitBufferExec,
  cwd: string,
  oid: string,
  filePath: string
): Promise<{ content: string; isBinary: boolean }> {
  // Why: Git's `<oid>:<path>` syntax expects forward slashes even on Windows.
  const gitPath = filePath.replace(/\\/g, '/')
  // preview bytes must resolve LFS pointers using the host's smudge filter
  const command = PREVIEWABLE_MIME[path.extname(filePath).toLowerCase()]
    ? ['cat-file', '--filters', '--']
    : ['show', '--end-of-options']
  try {
    const buf = await gitBuffer([...command, `${oid}:${gitPath}`], cwd)
    const content = PREVIEWABLE_MIME[path.extname(filePath).toLowerCase()]
      ? await resolveGitLfsPreview(buf, gitPath, (args, stdin) => gitBuffer(args, cwd, { stdin }))
      : buf
    return bufferToBlob(content, filePath)
  } catch (error) {
    if (isGitReadInterruptedError(error)) {
      throw error
    }
    if (isGitBufferOverflowError(error)) {
      return { content: '', isBinary: true }
    }
    if (PREVIEWABLE_MIME[path.extname(filePath).toLowerCase()]) {
      const present = await probeGitBlobPresence((args) => gitBuffer(args, cwd), gitPath, oid)
      return { content: '', isBinary: present !== false }
    }
    return { content: '', isBinary: false }
  }
}

export async function readBlobAtIndex(
  gitBuffer: GitBufferExec,
  cwd: string,
  filePath: string
): Promise<{ content: string; isBinary: boolean; missing: boolean; unmerged?: boolean }> {
  // Why: Git's `:<path>` syntax expects forward slashes even on Windows.
  const gitPath = filePath.replace(/\\/g, '/')
  // preview bytes must resolve LFS pointers using the host's smudge filter
  const command = PREVIEWABLE_MIME[path.extname(filePath).toLowerCase()]
    ? ['cat-file', '--filters', '--']
    : ['show', '--end-of-options']
  try {
    const buf = await gitBuffer([...command, `:${gitPath}`], cwd)
    const content = PREVIEWABLE_MIME[path.extname(filePath).toLowerCase()]
      ? await resolveGitLfsPreview(buf, gitPath, (args, stdin) => gitBuffer(args, cwd, { stdin }))
      : buf
    return { ...bufferToBlob(content, filePath), missing: false }
  } catch (error) {
    if (isGitReadInterruptedError(error)) {
      throw error
    }
    if (isGitBufferOverflowError(error)) {
      return { content: '', isBinary: true, missing: false }
    }
    if (PREVIEWABLE_MIME[path.extname(filePath).toLowerCase()]) {
      const present = await probeGitBlobPresence((args) => gitBuffer(args, cwd), gitPath)
      return {
        content: '',
        isBinary: present !== false,
        missing: present === false,
        ...(present === 'unmerged' ? { unmerged: true } : {})
      }
    }
    return { content: '', isBinary: false, missing: isMissingGitBlobPath(error, gitPath) }
  }
}

export async function readUnstagedLeft(
  gitBuffer: GitBufferExec,
  cwd: string,
  filePath: string
): Promise<{ content: string; isBinary: boolean }> {
  const index = await readBlobAtIndex(gitBuffer, cwd, filePath)
  if (!index.unmerged && !index.missing) {
    return index
  }
  return readBlobAtOid(gitBuffer, cwd, 'HEAD', filePath)
}
