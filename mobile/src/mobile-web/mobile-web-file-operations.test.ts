import { describe, expect, it, vi } from 'vitest'
import { Buffer } from 'buffer/'
import { MOBILE_WEB_FILE_CONTENT_MAX_BYTES } from '../../../src/shared/mobile-web/bridge-operation-contract'
import type { RpcClient } from '../transport/rpc-client'
import { executeMobileWebFileOperation } from './mobile-web-file-operations'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

const IDENTITY_WORKSPACE_AUTHORITY = {
  hostWorkspaceId: (workspaceId: string) => workspaceId
} as MobileWebWorkspaceAuthority

describe('mobile web file operations', () => {
  it('lists bounded safe paths without exposing the host root', async () => {
    const client = rpcClient({
      worktree: 'workspace-1',
      rootPath: '/secret/worktree',
      files: [
        { relativePath: 'src/app.ts', basename: 'ignored', kind: 'text' },
        { relativePath: '../secret', basename: 'secret', kind: 'text' },
        { relativePath: 'assets/logo.png', basename: 'logo.png', kind: 'binary' }
      ],
      totalCount: 7,
      truncated: false
    })

    const result = await executeMobileWebFileOperation({
      operation: 'list',
      payload: { workspaceId: 'workspace-1', limit: 3 },
      client,
      workspaceAuthority: IDENTITY_WORKSPACE_AUTHORITY
    })

    expect(client.sendRequest).toHaveBeenCalledWith('files.searchPaths', {
      worktree: 'id:workspace-1',
      query: '',
      limit: 3
    })
    expect(result).toEqual({
      workspaceId: 'workspace-1',
      files: [
        { relativePath: 'src/app.ts', basename: 'app.ts', kind: 'text' },
        { relativePath: 'assets/logo.png', basename: 'logo.png', kind: 'binary' }
      ],
      totalCount: 7,
      truncated: true
    })
    expect(JSON.stringify(result)).not.toContain('/secret/worktree')
  })

  it('reads an exact relative path and applies the page response byte cap', async () => {
    const content = 'x'.repeat(MOBILE_WEB_FILE_CONTENT_MAX_BYTES + 16)
    const client = rpcClient({
      worktree: 'workspace-1',
      relativePath: 'src/app.ts',
      content,
      truncated: false,
      byteLength: content.length
    })

    const result = await executeMobileWebFileOperation({
      operation: 'read',
      payload: { workspaceId: 'workspace-1', relativePath: 'src/app.ts' },
      client,
      workspaceAuthority: IDENTITY_WORKSPACE_AUTHORITY
    })

    expect(result).toMatchObject({
      workspaceId: 'workspace-1',
      relativePath: 'src/app.ts',
      truncated: true,
      byteLength: content.length
    })
    expect('contentBase64' in result).toBe(true)
    if ('contentBase64' in result) {
      expect(Buffer.from(result.contentBase64, 'base64')).toHaveLength(
        MOBILE_WEB_FILE_CONTENT_MAX_BYTES
      )
    }
  })

  it('does not split a multi-byte character at the preview cap', async () => {
    const content = '€'.repeat(Math.ceil(MOBILE_WEB_FILE_CONTENT_MAX_BYTES / 3) + 1)
    const client = rpcClient({
      worktree: 'workspace-1',
      relativePath: 'src/unicode.txt',
      content,
      truncated: false,
      byteLength: Buffer.byteLength(content)
    })

    const result = await executeMobileWebFileOperation({
      operation: 'read',
      payload: { workspaceId: 'workspace-1', relativePath: 'src/unicode.txt' },
      client,
      workspaceAuthority: IDENTITY_WORKSPACE_AUTHORITY
    })

    expect('contentBase64' in result).toBe(true)
    if ('contentBase64' in result) {
      const decoded = Buffer.from(result.contentBase64, 'base64')
      expect(decoded.byteLength).toBeLessThanOrEqual(MOBILE_WEB_FILE_CONTENT_MAX_BYTES)
      expect(decoded.toString('utf8')).not.toContain('�')
    }
  })

  it('rejects traversal before contacting the host', async () => {
    const client = rpcClient({})
    await expect(
      executeMobileWebFileOperation({
        operation: 'read',
        payload: { workspaceId: 'workspace-1', relativePath: '../secret' },
        client,
        workspaceAuthority: IDENTITY_WORKSPACE_AUTHORITY
      })
    ).rejects.toThrow()
    expect(client.sendRequest).not.toHaveBeenCalled()
  })

  it('sanitizes a bounded directory and derives a stable revision', async () => {
    const client = rpcClient([
      { name: 'file.ts', isDirectory: false, isSymlink: false },
      { name: 'src', isDirectory: true, isSymlink: false },
      { name: '../secret', isDirectory: false, isSymlink: false }
    ])
    const result = await executeMobileWebFileOperation({
      operation: 'directory',
      payload: { workspaceId: 'workspace-1', relativePath: '', limit: 3 },
      client,
      workspaceAuthority: IDENTITY_WORKSPACE_AUTHORITY
    })

    expect(client.sendRequest).toHaveBeenCalledWith('files.readDir', {
      worktree: 'id:workspace-1',
      relativePath: ''
    })
    expect(result).toMatchObject({
      workspaceId: 'workspace-1',
      relativePath: '',
      entries: [
        { name: 'src', isDirectory: true, isSymlink: false },
        { name: 'file.ts', isDirectory: false, isSymlink: false }
      ],
      truncated: true,
      revision: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
  })

  it('preserves exact file chunk bytes and rejects host length mismatches', async () => {
    const client = rpcClient({ contentBase64: 'AAH/', bytesRead: 3, eof: false })
    await expect(
      executeMobileWebFileOperation({
        operation: 'readChunk',
        payload: {
          workspaceId: 'workspace-1',
          relativePath: 'data.bin',
          offset: 4,
          length: 3
        },
        client,
        workspaceAuthority: IDENTITY_WORKSPACE_AUTHORITY
      })
    ).resolves.toMatchObject({
      workspaceId: 'workspace-1',
      relativePath: 'data.bin',
      offset: 4,
      contentBase64: 'AAH/',
      bytesRead: 3,
      eof: false
    })

    client.sendRequest = vi
      .fn()
      .mockResolvedValue({ ok: true, result: { contentBase64: 'AA==', bytesRead: 2, eof: true } })
    await expect(
      executeMobileWebFileOperation({
        operation: 'readChunk',
        payload: {
          workspaceId: 'workspace-1',
          relativePath: 'data.bin',
          offset: 0,
          length: 2
        },
        client,
        workspaceAuthority: IDENTITY_WORKSPACE_AUTHORITY
      })
    ).rejects.toThrow()
  })
})

function rpcClient(result: unknown): RpcClient {
  return {
    sendRequest: vi.fn().mockResolvedValue({ ok: true, result })
  } as unknown as RpcClient
}
