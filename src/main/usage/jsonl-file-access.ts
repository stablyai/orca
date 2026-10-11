import { open } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { isWslUncPath } from '../../shared/wsl-paths'
import {
  closeTranscriptHandle,
  openTranscriptFile,
  readTranscriptFile,
  WSL_TRANSCRIPT_READ_CHUNK_BYTES
} from '../native-chat/wsl-transcript-fs-access'
import { wslGatedHandleStat } from '../native-chat/wsl-transcript-fs-snapshot'
import type { TranscriptBigIntStat } from '../native-chat/wsl-transcript-fs-process-protocol'

export type JsonlFileHandle = {
  stat(options: { bigint: true }): Promise<TranscriptBigIntStat>
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number
  ): Promise<{ bytesRead: number; buffer: Buffer }>
  close(): Promise<void>
  createReadStream(options: { start: number; end: number; autoClose: false }): Readable
}

/** WSL reads keep one pinned process handle for stream, checkpoint and identity checks. */
export async function openJsonlFileHandle(path: string): Promise<JsonlFileHandle> {
  if (!isWslUncPath(path)) {
    return open(path, 'r')
  }
  const handle = await openTranscriptFile(path, 'scan')
  return {
    stat: () => wslGatedHandleStat(handle, path, 'scan'),
    read: (buffer, offset, length, position) =>
      readTranscriptFile(handle, path, buffer, offset, length, position, 'scan'),
    close: () => closeTranscriptHandle(handle, path),
    createReadStream: ({ start, end }) =>
      Readable.from(
        (async function* () {
          for (let position = start; position <= end;) {
            const length = Math.min(WSL_TRANSCRIPT_READ_CHUNK_BYTES, end - position + 1)
            const buffer = Buffer.allocUnsafe(length)
            const { bytesRead } = await readTranscriptFile(
              handle,
              path,
              buffer,
              0,
              length,
              position,
              'scan'
            )
            if (bytesRead === 0) {
              return
            }
            position += bytesRead
            yield buffer.subarray(0, bytesRead)
          }
        })()
      )
  }
}
