import type { SFTPWrapper } from 'ssh2'
import { vi } from 'vitest'

type ListingCallback = (error?: Error | null, result?: unknown) => void

export function withSftpDirectoryHandles<
  T extends { readdir: (path: string, callback: ListingCallback) => void }
>(sftp: T) {
  const read = sftp.readdir
  const exhausted = new WeakSet<Buffer>()
  Object.assign(sftp, {
    opendir: vi.fn((path: string, callback: ListingCallback) => callback(null, Buffer.from(path))),
    close: vi.fn((_handle: Buffer, callback: ListingCallback) => callback()),
    readdir: vi.fn((handle: Buffer, callback: ListingCallback) => {
      if (exhausted.has(handle)) {
        return callback(null, false)
      }
      exhausted.add(handle)
      read(handle.toString(), callback)
    })
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Fixtures provide the file operations under test; the adapter adds opendir, handle readdir, and close.
  return sftp as unknown as SFTPWrapper
}
