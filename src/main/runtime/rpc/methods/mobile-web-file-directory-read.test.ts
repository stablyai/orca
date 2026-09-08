import { afterEach, describe, expect, it, vi } from 'vitest'
import { MOBILE_WEB_FILE_DIRECTORY_READ_METHOD as method } from './mobile-web-file-directory-read'
import { FILE_METHODS } from './files'
import type { RpcContext } from '../core'
import { sanitizeDirectoryResult } from '../../../../shared/mobile-web/file-host-presentation'

const source = FILE_METHODS.find((entry) => entry.name === 'files.readDir')!
afterEach(() => vi.restoreAllMocks())

describe('bounded mobile directory reads', () => {
  it('preserves directory truncation and ordering when raw entries exceed bridge bytes', async () => {
    const entries = Array.from({ length: 4000 }, (_, index) => ({
      name: `${String(index).padStart(4, '0')}-${'x'.repeat(240)}`,
      isDirectory: index % 2 === 0,
      isSymlink: false,
      futureField: 'unbounded host metadata'
    }))
    expect(Buffer.byteLength(JSON.stringify(entries))).toBeGreaterThan(512 * 1024)
    const handler = vi.spyOn(source, 'handler').mockResolvedValue(entries)
    const context = { signal: new AbortController().signal } as RpcContext
    const result = await method.handler(
      { worktree: 'id:remote-folder', relativePath: '', limit: 128 },
      context
    )
    expect(result).toEqual(sanitizeDirectoryResult(entries, '', 128))
    expect(result).toMatchObject({ truncated: true })
    expect(result).toMatchObject({ entries: expect.any(Array) })
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(512 * 1024)
    expect(handler).toHaveBeenCalledWith(
      { worktree: 'id:remote-folder', relativePath: '' },
      context
    )
    expect(result).not.toHaveProperty('worktree')
    expect(result).not.toHaveProperty('workspaceId')
  })

  it('preserves execution-host errors instead of returning an empty local directory', async () => {
    vi.spyOn(source, 'handler').mockRejectedValue(new Error('SSH provider unavailable'))
    await expect(
      method.handler({ worktree: 'id:remote', relativePath: 'docs', limit: 10 }, {} as RpcContext)
    ).rejects.toThrow('SSH provider unavailable')
  })

  it('rejects a limit beyond the existing directory ceiling', () => {
    expect(
      method.params!.safeParse({ worktree: 'id:folder', relativePath: '', limit: 129 }).success
    ).toBe(false)
  })
})
