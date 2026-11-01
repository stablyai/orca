import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, realpath, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { FileBytesWritePrecondition } from '../../../shared/file-bytes-write'
import { FILE_WRITE_OK, type FileWriteResult } from '../../../shared/file-write-disk-precondition'
import { renameFileWithWindowsRetryAsync } from '../../../shared/windows-retry-file-operations'
import { windowsFsPath } from '../../wsl/wsl-unc-drive-fs-path'
import { isENOENT } from './filesystem-path-containment'
import { runLocalEditorWrite } from './local-disk-write-precondition'
import { assertLocalWriteTargetIsRegularFile } from './local-regular-file-read'

async function sha256OfFile(filePath: string): Promise<string | null> {
  const hash = createHash('sha256')
  try {
    for await (const chunk of createReadStream(filePath)) {
      hash.update(chunk)
    }
  } catch (error) {
    if (isENOENT(error)) {
      return null
    }
    throw error
  }
  return hash.digest('hex')
}

/**
 * Replaces a file's bytes atomically (sibling temp file, then rename) unless it no longer holds
 * the bytes the editor loaded. A symlink is followed, so its target is replaced, not the link.
 */
export async function replaceLocalFileBytesIfUnchanged(
  requestedPath: string,
  writeTemp: (tempPath: string) => Promise<void>,
  precondition: FileBytesWritePrecondition
): Promise<FileWriteResult> {
  const filePath = windowsFsPath(requestedPath)
  return runLocalEditorWrite(filePath, async () => {
    const target = await realpath(filePath).catch((error: unknown) => {
      if (isENOENT(error)) {
        return filePath
      }
      throw error
    })
    if (precondition.expectedSha256 !== undefined) {
      const current = await sha256OfFile(target)
      if (current === null && precondition.allowMissing !== true) {
        return { ok: false, diskConflict: 'missing' }
      }
      if (current !== null && current !== precondition.expectedSha256) {
        return { ok: false, diskConflict: 'changed' }
      }
    }
    await assertLocalWriteTargetIsRegularFile(target)
    const mode = await stat(target).then(
      (stats) => stats.mode & 0o7777,
      () => null
    )
    const temp = join(dirname(target), `.${basename(target)}.orca-save-${randomUUID()}`)
    try {
      await writeTemp(temp)
      if (mode !== null) {
        await chmod(temp, mode)
      }
      await renameFileWithWindowsRetryAsync(temp, target)
    } finally {
      await rm(temp, { force: true }).catch(() => undefined)
    }
    return FILE_WRITE_OK
  })
}
