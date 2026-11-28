// The files a `send --on --file` uploads, opened and sized before the first upload: a file that
// can't be read sends nothing, and each upload reads exactly the bytes it sized.
import { constants } from 'node:fs'
import { open, stat, type FileHandle } from 'node:fs/promises'
import { basename } from 'node:path'
import { AGENT_SESSION_ATTACHMENT_MAX_BYTES } from '../../../../../../shared/agent-session/agent-session-attachments'

const MB = 1024 * 1024
// A FIFO with no writer would block a plain open; a regular file reads the same either way.
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)

export type OpenedFile = { handle: FileHandle; size: number }

/** Each file opened for reading, with its size; `refused` names one that can't be, and nothing is
 *  left open then. Only regular files are opened. */
export async function openAll(
  files: readonly string[],
  refused: (message: string) => Error
): Promise<OpenedFile[]> {
  const opened: OpenedFile[] = []
  try {
    for (const path of files) {
      const unreadable = () => refused(`${basename(path)} can't be read.`)
      if (!(await stat(path).catch(() => null))?.isFile()) {
        throw unreadable()
      }
      const handle = await open(path, OPEN_FLAGS).catch(() => null)
      if (!handle) {
        throw unreadable()
      }
      const info = await handle.stat().catch(() => null)
      opened.push({ handle, size: info?.size ?? 0 })
      // The opened file is the one checked: a path swapped after the first check is caught here.
      if (!info?.isFile()) {
        throw unreadable()
      }
      if (info.size > AGENT_SESSION_ATTACHMENT_MAX_BYTES) {
        throw refused(`${basename(path)} is over ${AGENT_SESSION_ATTACHMENT_MAX_BYTES / MB} MB.`)
      }
    }
    return opened
  } catch (error) {
    await closeAll(opened)
    throw error
  }
}

export async function closeAll(opened: readonly OpenedFile[]): Promise<void> {
  await Promise.all(opened.map(({ handle }) => handle.close().catch(() => {})))
}

/** The file's bytes, exactly as many as it was sized at; null when it grew or shrank since. Reads at
 *  most one byte more than that, so a growing file can't take more memory than it was sized for. */
export async function readSized({ handle, size }: OpenedFile): Promise<Buffer | null> {
  const buffer = Buffer.alloc(size + 1)
  let read = 0
  while (read < buffer.byteLength) {
    const { bytesRead } = await handle.read(buffer, read, buffer.byteLength - read, read)
    if (bytesRead === 0) {
      break
    }
    read += bytesRead
  }
  return read === size ? buffer.subarray(0, size) : null
}
