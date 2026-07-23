import { describe, expect, it, vi } from 'vitest'
import {
  FILESYSTEM_DIRECTORY_MAX_ENTRIES,
  FILESYSTEM_DIRECTORY_MAX_RETAINED_BYTES
} from '../../shared/filesystem-directory-listing-limit'
import { JsonRpcErrorCode } from '../ssh/relay-protocol'
import { SSH_BOUNDED_READ_DIR_UNAVAILABLE_MESSAGE } from './ssh-filesystem-directory-reader'
import { SshFilesystemProvider } from './ssh-filesystem-provider'

function createProvider(request: ReturnType<typeof vi.fn>): SshFilesystemProvider {
  return new SshFilesystemProvider('conn-1', {
    request,
    onNotification: vi.fn(() => () => {})
  } as never)
}

describe('SshFilesystemProvider directory limits', () => {
  it('routes normal listings through the bounded method without changing results', async () => {
    const entries = [
      { name: 'src', isDirectory: true, isSymlink: false },
      { name: 'README.md', isDirectory: false, isSymlink: false }
    ]
    const request = vi.fn().mockResolvedValue(entries)
    const provider = createProvider(request)

    await expect(provider.readDir('/home/user/project')).resolves.toEqual(entries)
    expect(request).toHaveBeenCalledWith('fs.readDirBounded', {
      dirPath: '/home/user/project',
      maxEntries: FILESYSTEM_DIRECTORY_MAX_ENTRIES,
      maxRetainedBytes: FILESYSTEM_DIRECTORY_MAX_RETAINED_BYTES
    })
  })

  it('forwards stricter mobile directory retention limits', async () => {
    const request = vi.fn().mockResolvedValue([])
    const provider = createProvider(request)

    await provider.readDir('/home/user/project', {
      maxEntries: 10_000,
      maxRetainedBytes: 4 * 1024 * 1024
    })

    expect(request).toHaveBeenCalledWith('fs.readDirBounded', {
      dirPath: '/home/user/project',
      maxEntries: 10_000,
      maxRetainedBytes: 4 * 1024 * 1024
    })
  })

  it('validates bounded relay results before returning them', async () => {
    const request = vi.fn().mockResolvedValue([
      { name: 'one', isDirectory: false, isSymlink: false },
      { name: 'two', isDirectory: false, isSymlink: false },
      { name: 'three', isDirectory: false, isSymlink: false }
    ])
    const provider = createProvider(request)

    await expect(
      provider.readDir('/home/user/project', { maxEntries: 2, maxRetainedBytes: 1024 })
    ).rejects.toThrow('This folder is too large to list safely')
  })

  it('requires reconnect instead of falling back to an unbounded old relay', async () => {
    const request = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('Method not found'), { code: JsonRpcErrorCode.MethodNotFound })
      )
    const provider = createProvider(request)

    await expect(provider.readDir('/home/user/project')).rejects.toThrow(
      SSH_BOUNDED_READ_DIR_UNAVAILABLE_MESSAGE
    )
    await expect(provider.readDir('/home/user/project')).rejects.toThrow(
      SSH_BOUNDED_READ_DIR_UNAVAILABLE_MESSAGE
    )
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).not.toHaveBeenCalledWith('fs.readDir', expect.anything())
  })
})
