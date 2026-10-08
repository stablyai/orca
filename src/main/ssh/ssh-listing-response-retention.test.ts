import { expect, it, vi } from 'vitest'
import type { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import { requestGitStreamable } from './ssh-git-response-stream-reader'

function fixture(result: unknown) {
  const listeners = new Map<string, (params: Record<string, unknown>) => void>()
  const mock = {
    request: vi.fn().mockResolvedValue(result),
    notify: vi.fn(),
    isDisposed: () => false,
    onDispose: () => () => {},
    onNotificationByMethod: (
      method: string,
      listener: (params: Record<string, unknown>) => void
    ) => {
      listeners.set(method, listener)
      return () => {
        listeners.delete(method)
      }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture implements the reader's request, notification, and disposal operations.
  return { mux: mock as unknown as SshChannelMultiplexer, mock, listeners }
}

it('refuses oversized stream metadata before retaining any chunks and cancels the pump', async () => {
  const { mux, mock, listeners } = fixture({
    __orcaGitResponseStream: { streamId: 1, totalBytes: 129, chunkCount: 2 }
  })
  await expect(
    requestGitStreamable(mux, 'fs.readDirBounded', {}, { maxResponseBytes: 128 })
  ).rejects.toThrow('retention budget')
  expect(mock.notify).toHaveBeenCalledWith('git.cancelResponseStream', { streamId: 1 })
  expect(listeners.size).toBe(0)
})

it('rejects a chunk past the advertised retention limit and detaches listeners', async () => {
  const { mux, mock, listeners } = fixture({
    __orcaGitResponseStream: { streamId: 2, totalBytes: 64, chunkCount: 1 }
  })
  const result = requestGitStreamable(mux, 'fs.readDirBounded', {}, { maxResponseBytes: 64 })
  const outcome = expect(result).rejects.toThrow('retention budget')
  await Promise.resolve()
  listeners.get('git.responseChunk')?.({
    streamId: 2,
    seq: 0,
    data: Buffer.alloc(65).toString('base64')
  })
  await outcome
  expect(mock.notify).toHaveBeenCalledWith('git.cancelResponseStream', { streamId: 2 })
  expect(listeners.size).toBe(0)
})

it('validates old-peer plain replies against the same reader byte budget', async () => {
  const { mux, listeners } = fixture(['x'.repeat(129)])
  await expect(
    requestGitStreamable(mux, 'fs.listFiles', {}, { maxResponseBytes: 128 })
  ).rejects.toThrow('exceeds')
  expect(listeners.size).toBe(0)
})
