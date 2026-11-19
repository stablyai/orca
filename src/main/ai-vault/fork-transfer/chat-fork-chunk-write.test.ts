import { expect, it } from 'vitest'
import { writeChatForkChunk } from './chat-fork-chunk-write'

it('writes a chunk whole even when the file takes it in pieces', async () => {
  const stored = Buffer.alloc(8)
  const handle = {
    write: async (buffer: Buffer, offset: number, length: number, position: number) => {
      const bytesWritten = Math.min(2, length)
      buffer.copy(stored, position, offset, offset + bytesWritten)
      return { bytesWritten }
    }
  }
  await writeChatForkChunk(handle, Buffer.from('hello'), 3)
  expect(stored.subarray(3).toString()).toBe('hello')
  const stalled = { write: async () => ({ bytesWritten: 0 }) }
  await expect(writeChatForkChunk(stalled, Buffer.from('hi'), 0)).rejects.toThrow(
    'chat_fork_transfer_integrity_failed'
  )
})
