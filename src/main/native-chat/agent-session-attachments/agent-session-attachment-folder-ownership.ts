// Only the attempt that made an upload folder undoes it, and never recursively.

import { access, mkdir, rm, rmdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { renameFileWithWindowsRetryAsync } from '../../../shared/file-write/windows-retry-file-operations'
import { AGENT_SESSION_ATTACHMENT_PART_FILE } from './agent-session-attachment-references'

/** Content-named folders may already hold other files, so failure undoes only this write. */
export async function writeContent(uploadDir: string, path: string, bytes: Buffer): Promise<void> {
  if (
    await access(path).then(
      () => true,
      () => false
    )
  ) {
    return
  }
  const partPath = join(uploadDir, AGENT_SESSION_ATTACHMENT_PART_FILE)
  let created: string | undefined
  let writing = false
  try {
    created = await mkdir(uploadDir, { recursive: true })
    // Writes to one folder are serialized, so a part file begun here is this write's, even partial.
    writing = true
    await writeFile(partPath, bytes)
    await renameFileWithWindowsRetryAsync(partPath, path)
  } catch (error) {
    // Undo only what this write made: a reused folder's other files stay for the sweep.
    if (writing) {
      await rm(partPath, { force: true }).catch(() => {})
    }
    if (created !== undefined) {
      await rmdir(uploadDir).catch(() => {})
    }
    throw error
  }
}

/** Makes a new upload folder or fails: an existing one, whoever made it, is never adopted. */
export async function createUploadFolder(rootDir: string, uploadDir: string): Promise<void> {
  await mkdir(rootDir, { recursive: true })
  await mkdir(uploadDir)
}

export type OwnedUploadFolder = { uploadDir: string; owned: boolean }

/** Undoes an upload this store made: its part file, then its folder only if nothing else is in it. */
export async function removeOwnedUpload(upload: OwnedUploadFolder): Promise<void> {
  if (!upload.owned) {
    return
  }
  const partPath = join(upload.uploadDir, AGENT_SESSION_ATTACHMENT_PART_FILE)
  await rm(partPath, { force: true }).catch(() => {})
  await rmdir(upload.uploadDir).catch(() => {})
}
