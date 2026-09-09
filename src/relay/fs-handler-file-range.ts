import { open } from 'node:fs/promises'
import { validateFileRangeRequest } from '../shared/file-range-read'
import { readFullStreamChunk } from './fs-handler-file-read'

/** Positional read for tailing an append-only file. Fills the window until
 *  `length` is satisfied or the file genuinely ends, so a short result always
 *  means EOF and never a partial syscall. Base64 because the payload is
 *  arbitrary bytes and may split a UTF-8 sequence at either edge.
 *
 *  Validates here rather than at the dispatcher: this is the function that puts
 *  a caller-supplied offset into a read syscall, so it is the boundary that has
 *  to hold even if a future call site forgets. */
export async function readRelayFileRange(
  filePath: string,
  rawPosition: unknown,
  rawLength: unknown
): Promise<{ base64: string; bytesRead: number }> {
  const { position, length } = validateFileRangeRequest(rawPosition, rawLength)
  const handle = await open(filePath, 'r')
  try {
    // allocUnsafe over alloc: only `subarray(0, bytesRead)` is ever read back, so
    // uninitialised bytes cannot escape, and a tailing poll with a generous
    // `length` should not pay a memset over the whole window per call.
    const buffer = Buffer.allocUnsafe(length)
    const bytesRead = await readFullStreamChunk(handle, buffer, length, position)
    return { base64: buffer.subarray(0, bytesRead).toString('base64'), bytesRead }
  } finally {
    await handle.close()
  }
}
