// Only the attempt that made an upload folder undoes it, and never recursively.

import { access, mkdir, open, rm, rmdir } from 'node:fs/promises'
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
  let opened = false
  try {
    created = await mkdir(uploadDir, { recursive: true })
    // Once this write has the part file open it is this write's, even if only partly written.
    const part = await open(partPath, 'w')
    opened = true
    try {
      await part.writeFile(bytes)
    } finally {
      await part.close()
    }
    await renameFileWithWindowsRetryAsync(partPath, path)
  } catch (error) {
    // Undo only what this write made: a reused folder's other files stay for the sweep.
    if (opened) {
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

/** `owned` once this store made the folder; `part` once it made, or handed out, the part file. */
export type OwnedUploadFolder = { uploadDir: string; owned: boolean; part: boolean }

/** Undoes an upload this store made: its part file, then its folder only if nothing else is in it. */
export async function removeOwnedUpload(upload: OwnedUploadFolder): Promise<void> {
  if (!upload.owned) {
    return
  }
  if (upload.part) {
    const partPath = join(upload.uploadDir, AGENT_SESSION_ATTACHMENT_PART_FILE)
    await rm(partPath, { force: true }).catch(() => {})
  }
  await rmdir(upload.uploadDir).catch(() => {})
}
