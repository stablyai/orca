import { describe, expect, it, vi } from 'vitest'
import type { RpcFailure, RpcResponse, RpcSuccess } from '../transport/types'
import {
  createMobileFilePreviewRequest,
  formatPreviewByteLength,
  loadMobileFilePreview,
  normalizeMobileFilePreviewResponse
} from './mobile-file-preview-request'

function ok(result: unknown): RpcSuccess {
  return { id: '1', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function fail(message: string, code = 'error'): RpcFailure {
  return { id: '1', ok: false, error: { code, message }, _meta: { runtimeId: 'runtime-1' } }
}

function clientWith(response: RpcResponse) {
  return {
    sendRequest: vi.fn(async () => response)
  }
}

describe('mobile-file-preview-request', () => {
  it('selects readPreview for raster images and read for text-like files', () => {
    expect(createMobileFilePreviewRequest('wt-1', 'assets/logo.png')).toEqual({
      method: 'files.readPreview',
      params: { worktree: 'id:wt-1', relativePath: 'assets/logo.png' }
    })
    expect(createMobileFilePreviewRequest('wt-1', 'docs/readme.md')).toEqual({
      method: 'files.read',
      params: { worktree: 'id:wt-1', relativePath: 'docs/readme.md' }
    })
    expect(createMobileFilePreviewRequest('wt-1', 'public/index.html')).toEqual({
      method: 'files.read',
      params: { worktree: 'id:wt-1', relativePath: 'public/index.html' }
    })
  })

  it('loads images through readPreview and never calls files.open', async () => {
    const client = clientWith(
      ok({ content: 'aW1hZ2U=', isBinary: true, isImage: true, mimeType: 'image/png' })
    )

    await expect(loadMobileFilePreview(client, 'wt-1', 'assets/logo.png')).resolves.toEqual({
      status: 'ready',
      kind: 'image',
      dataUri: 'data:image/png;base64,aW1hZ2U='
    })
    expect(client.sendRequest).toHaveBeenCalledWith('files.readPreview', {
      worktree: 'id:wt-1',
      relativePath: 'assets/logo.png'
    })
    expect(client.sendRequest).not.toHaveBeenCalledWith('files.open', expect.anything())
  })

  it.each([
    ['missing isBinary', { content: 'aW1hZ2U=', isImage: true, mimeType: 'image/png' }],
    ['missing isImage', { content: 'aW1hZ2U=', isBinary: true, mimeType: 'image/png' }],
    ['missing mimeType', { content: 'aW1hZ2U=', isBinary: true, isImage: true }],
    ['empty content', { content: '', isBinary: true, isImage: true, mimeType: 'image/png' }]
  ])('rejects invalid image preview results: %s', (_label, result) => {
    expect(normalizeMobileFilePreviewResponse('assets/logo.png', ok(result))).toEqual({
      status: 'error',
      message: 'Binary preview unavailable',
      reconnect: false
    })
  })

  it('normalizes markdown, html, text, empty, and truncated reads', () => {
    expect(
      normalizeMobileFilePreviewResponse(
        'README.md',
        ok({ content: '# Hi', truncated: false, byteLength: 4 })
      )
    ).toEqual({
      status: 'ready',
      kind: 'markdown',
      content: '# Hi',
      truncated: false,
      byteLength: 4
    })
    expect(
      normalizeMobileFilePreviewResponse(
        'index.html',
        ok({ content: '<h1>Hi</h1>', truncated: false, byteLength: 11 })
      )
    ).toMatchObject({ status: 'ready', kind: 'html' })
    expect(
      normalizeMobileFilePreviewResponse(
        'src/app.ts',
        ok({ content: 'const a = 1', truncated: true, byteLength: 700_000 })
      )
    ).toEqual({
      status: 'ready',
      kind: 'text',
      content: 'const a = 1',
      truncated: true,
      byteLength: 700_000
    })
    expect(
      normalizeMobileFilePreviewResponse(
        'empty.txt',
        ok({ content: '', truncated: false, byteLength: 0 })
      )
    ).toEqual({ status: 'empty', kind: 'text' })
  })

  it.each([
    ['binary_file', 'Binary preview unavailable', false],
    ['file_too_large', 'File too large for mobile preview', false],
    ['ENOENT: no such file or directory', 'File not found', false],
    [
      'Remote connection dropped. Click Reconnect on the SSH target before retrying.',
      'Unable to reach the desktop filesystem',
      true
    ],
    ['provider unavailable', 'Unable to reach the desktop filesystem', true],
    ['permission denied', 'Unable to load preview', false]
  ])('maps preview failure %s', (message, expected, reconnect) => {
    expect(normalizeMobileFilePreviewResponse('src/app.ts', fail(message))).toEqual({
      status: 'error',
      message: expected,
      reconnect
    })
  })

  it('formats truncation byte counts for the UI note', () => {
    expect(formatPreviewByteLength(512)).toBe('512 B')
    expect(formatPreviewByteLength(4096)).toBe('4 KB')
    expect(formatPreviewByteLength(1_572_864)).toBe('1.5 MB')
  })
})
