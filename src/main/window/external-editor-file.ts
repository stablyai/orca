import { open, realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { authorizeExternalPath } from '../ipc/filesystem-auth'
import { hasBinaryFileExtension } from '../../shared/binary-file-extensions'

const MAX_EXTERNAL_EDITOR_BYTES = 1024 * 1024

/** Validate the selected file before granting session-wide filesystem access. */
export async function authorizeExternalEditorFile(filePath: string): Promise<string> {
  if (!isAbsolute(filePath)) {
    throw new Error('An absolute file path is required.')
  }
  const canonicalPath = await realpath(filePath)
  if (hasBinaryFileExtension(canonicalPath)) {
    throw new Error('The editor target must be a text file.')
  }
  if (!(await stat(canonicalPath)).isFile()) {
    throw new Error('The editor target must be a regular file.')
  }
  const file = await open(canonicalPath, 'r')
  try {
    const metadata = await file.stat()
    if (!metadata.isFile()) {
      throw new Error('The editor target must be a regular file.')
    }
    if (metadata.size > MAX_EXTERNAL_EDITOR_BYTES) {
      throw new Error('The editor target exceeds 1 MiB.')
    }
    const buffer = Buffer.alloc(MAX_EXTERNAL_EDITOR_BYTES + 1)
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const read = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
      if (read.bytesRead === 0) {
        break
      }
      bytesRead += read.bytesRead
    }
    if (bytesRead > MAX_EXTERNAL_EDITOR_BYTES) {
      throw new Error('The editor target exceeds 1 MiB.')
    }
    const content = buffer.subarray(0, bytesRead)
    if (content.includes(0)) {
      throw new Error('The editor target must be UTF-8 text.')
    }
    new TextDecoder('utf-8', { fatal: true }).decode(content)
  } finally {
    await file.close()
  }
  authorizeExternalPath(canonicalPath)
  return canonicalPath
}
