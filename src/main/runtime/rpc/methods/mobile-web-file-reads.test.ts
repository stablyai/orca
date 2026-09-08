import { afterEach, describe, expect, it, vi } from 'vitest'
import { MOBILE_WEB_FILE_READ_METHODS } from './mobile-web-file-reads'
import { FILE_METHODS } from './files'
import type { RpcContext } from '../core'

afterEach(() => vi.restoreAllMocks())

describe('page-safe host file reads', () => {
  it.each(['searchPaths', 'read'])(
    'reuses files.%s while keeping host identity off the page',
    async (operation) => {
      const source = FILE_METHODS.find((method) => method.name === `files.${operation}`)!
      const method = MOBILE_WEB_FILE_READ_METHODS.find(
        (entry) => entry.name === `mobileWeb.files.${operation}`
      )!
      const handler = vi.spyOn(source, 'handler').mockResolvedValue({
        worktree: 'host-workspace-id',
        rootPath: '/private/host/repository',
        relativePath: 'docs/readme.md',
        content: 'hello',
        byteLength: 5,
        truncated: false,
        files: [],
        futureField: { kind: 'new-domain-shape' }
      })
      const context = { signal: new AbortController().signal } as RpcContext
      const params = {
        worktree: 'id:host-workspace-id',
        relativePath: 'docs/readme.md',
        query: 'docs'
      }
      expect(method.params).toBe(source.params)
      const result = await method.handler(params, context)
      expect(handler).toHaveBeenCalledWith(params, context)
      expect(result).toEqual({
        relativePath: 'docs/readme.md',
        content: 'hello',
        byteLength: 5,
        truncated: false,
        files: [],
        futureField: { kind: 'new-domain-shape' }
      })
      expect(JSON.stringify(result)).not.toMatch(/host-workspace-id|private\/host/)
    }
  )

  it('preserves an execution-host failure instead of answering locally', async () => {
    const source = FILE_METHODS.find((method) => method.name === 'files.read')!
    vi.spyOn(source, 'handler').mockRejectedValue(new Error('SSH provider unavailable'))
    const method = MOBILE_WEB_FILE_READ_METHODS.find(
      (entry) => entry.name === 'mobileWeb.files.read'
    )!
    await expect(
      method.handler({ worktree: 'id:remote', relativePath: 'a.txt' }, {} as RpcContext)
    ).rejects.toThrow('SSH provider unavailable')
  })
})
