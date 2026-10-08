import { expect, it, vi } from 'vitest'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { JsonRpcErrorCode } from '../ssh/relay-protocol'
import { readSshDirectoryBounded } from './ssh-directory-listing'

function fixture() {
  const listeners = new Map<string, (params: Record<string, unknown>) => void>()
  const mux = {
    request: vi.fn(),
    notify: vi.fn(),
    isDisposed: () => false,
    onDispose: () => () => {},
    onNotificationByMethod: (
      method: string,
      callback: (params: Record<string, unknown>) => void
    ) => {
      listeners.set(method, callback)
      return () => listeners.delete(method)
    }
  }
  mux.request.mockRejectedValueOnce(
    Object.assign(new Error('old host'), { code: JsonRpcErrorCode.MethodNotFound })
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture implements all mux methods used by the response reader.
  return { mux: mux as unknown as SshChannelMultiplexer, mock: mux, listeners }
}

const entries = [{ name: 'README.md', isDirectory: false, isSymlink: false }]

it('preserves small old plain replies on system SSH without SFTP', async () => {
  const f = fixture()
  f.mock.request.mockResolvedValueOnce(entries)
  await expect(readSshDirectoryBounded(f.mux, '/remote')).resolves.toEqual(entries)
  expect(f.mock.request).toHaveBeenLastCalledWith('fs.readDir', {
    dirPath: '/remote',
    __streamResponse: true
  })
})

it('preserves old streamed replies without SFTP', async () => {
  const f = fixture()
  const encoded = Buffer.from(JSON.stringify(entries))
  f.mock.request.mockImplementationOnce(async () => {
    f.listeners.get('git.responseChunk')?.({
      streamId: 7,
      seq: 0,
      data: encoded.toString('base64')
    })
    f.listeners.get('git.responseEnd')?.({ streamId: 7 })
    return { __orcaGitResponseStream: { streamId: 7, totalBytes: encoded.length, chunkCount: 1 } }
  })
  await expect(readSshDirectoryBounded(f.mux, '/remote')).resolves.toEqual(entries)
})

it('prefers bounded SFTP to legacy producer allocation', async () => {
  const f = fixture()
  const fallback = vi.fn().mockResolvedValue(entries)
  await expect(readSshDirectoryBounded(f.mux, '/remote', fallback)).resolves.toEqual(entries)
  expect(f.mock.request).toHaveBeenCalledTimes(1)
  expect(fallback).toHaveBeenCalledOnce()
})

it('does not fall back for arbitrary failures', async () => {
  const f = fixture()
  f.mock.request.mockReset().mockRejectedValue(new Error('permission denied'))
  const fallback = vi.fn()
  await expect(readSshDirectoryBounded(f.mux, '/remote', fallback)).rejects.toThrow(
    'permission denied'
  )
  expect(f.mock.request).toHaveBeenCalledTimes(1)
  expect(fallback).not.toHaveBeenCalled()
})

it('rejects complete old replies that exceed metadata capacity', async () => {
  const f = fixture()
  f.mock.request.mockResolvedValueOnce(Array.from({ length: 100001 }, () => entries[0]))
  await expect(readSshDirectoryBounded(f.mux, '/remote')).rejects.toThrow('too large')
})

it('rejects oversized streamed old replies before accepting chunks', async () => {
  const f = fixture()
  f.mock.request.mockResolvedValueOnce({
    __orcaGitResponseStream: { streamId: 7, totalBytes: 17 * 1024 * 1024, chunkCount: 1 }
  })
  await expect(readSshDirectoryBounded(f.mux, '/remote')).rejects.toThrow('retention budget')
  expect(f.mock.notify).toHaveBeenCalledWith('git.cancelResponseStream', { streamId: 7 })
})

it('propagates legacy errors without another fallback', async () => {
  const f = fixture()
  f.mock.request.mockRejectedValueOnce(new Error('legacy permission denied'))
  await expect(readSshDirectoryBounded(f.mux, '/remote')).rejects.toThrow(
    'legacy permission denied'
  )
  expect(f.mock.request).toHaveBeenCalledTimes(2)
})
