import { ChatForkTransferError } from './chat-fork-transfer-ownership'

type ChunkWriter = {
  write(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number
  ): Promise<{ bytesWritten: number }>
}

/** A positional write may store fewer bytes than asked; loop so a chunk is acked only when whole. */
export async function writeChatForkChunk(
  handle: ChunkWriter,
  bytes: Buffer,
  position: number
): Promise<void> {
  let done = 0
  while (done < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, done, bytes.length - done, position + done)
    if (bytesWritten <= 0) {
      throw new ChatForkTransferError('chat_fork_transfer_integrity_failed')
    }
    done += bytesWritten
  }
}
