import { describe, expect, it } from 'vitest'
import type { RpcResponse } from '../transport/types'
import { resolveMobileFileTabDoc } from './mobile-file-tab-doc'

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l8sm7wAAAABJRU5ErkJggg=='

function ok(result: unknown): RpcResponse {
  return { id: 'x', ok: true, result, _meta: { runtimeId: 'r' } }
}

function fail(code: string, message: string): RpcResponse {
  return { id: 'x', ok: false, error: { code, message }, _meta: { runtimeId: 'r' } }
}

function clientOf(byMethod: Record<string, RpcResponse>): {
  sendRequest: (method: string, params?: unknown) => Promise<RpcResponse>
  calls: string[]
  requests: { method: string; params: unknown }[]
} {
  const calls: string[] = []
  const requests: { method: string; params: unknown }[] = []
  return {
    calls,
    requests,
    sendRequest: (method: string, params?: unknown) => {
      calls.push(method)
      requests.push({ method, params })
      const response = byMethod[method]
      if (!response) {
        throw new Error(`unexpected method ${method}`)
      }
      return Promise.resolve(response)
    }
  }
}

const WT = { worktreeId: 'wt1' }

describe('resolveMobileFileTabDoc', () => {
  it('hands video and music tabs to the same chunked player without requesting whole-file previews', async () => {
    const client = clientOf({})
    for (const [relativePath, mimeType] of [
      ['movie.MP4', 'video/mp4'],
      ['music.mp3', 'audio/mpeg']
    ]) {
      expect(await resolveMobileFileTabDoc(client, { ...WT, relativePath: relativePath! })).toEqual(
        {
          status: 'ready',
          kind: 'media',
          media: { ...WT, relativePath, mimeType }
        }
      )
    }
    expect(client.calls).toEqual([])
  })

  it('renders a staged text diff', async () => {
    const client = clientOf({
      'git.diff': ok({ kind: 'text', originalContent: 'a\n', modifiedContent: 'a\nb\n' })
    })
    const doc = await resolveMobileFileTabDoc(client, {
      ...WT,
      relativePath: 'a.ts',
      diffSource: 'staged'
    })
    expect(doc).toEqual({
      status: 'ready',
      kind: 'diff',
      lines: [
        { kind: 'context', text: 'a', oldLineNumber: 1, newLineNumber: 1 },
        { kind: 'add', text: 'b', newLineNumber: 2 }
      ],
      truncated: false
    })
    expect(client.requests).toEqual([
      { method: 'git.diff', params: { worktree: 'id:wt1', filePath: 'a.ts', staged: true } }
    ])
  })

  it('renders an unstaged image diff from the modified bytes', async () => {
    const client = clientOf({
      'git.diff': ok({
        kind: 'binary',
        originalContent: 'b2xk',
        modifiedContent: PNG_BASE64,
        modifiedIsBinary: true,
        isImage: true,
        mimeType: 'image/png'
      })
    })
    const doc = await resolveMobileFileTabDoc(client, {
      ...WT,
      relativePath: 'm1.png',
      diffSource: 'unstaged'
    })
    expect(doc).toEqual({
      status: 'ready',
      kind: 'image',
      dataUri: `data:image/png;base64,${PNG_BASE64}`
    })
  })

  it('throws binary_file for an image modify whose bytes are empty (no stale fallback)', async () => {
    const client = clientOf({
      'git.diff': ok({
        kind: 'binary',
        originalContent: 'b2xk',
        modifiedContent: '',
        modifiedIsBinary: true,
        isImage: true,
        mimeType: 'image/png'
      })
    })
    await expect(
      resolveMobileFileTabDoc(client, { ...WT, relativePath: 'm1.png', diffSource: 'unstaged' })
    ).rejects.toThrow('binary_file')
  })

  it('throws binary_file for a non-image binary diff', async () => {
    const client = clientOf({ 'git.diff': ok({ kind: 'binary', modifiedContent: 'AAAA' }) })
    await expect(
      resolveMobileFileTabDoc(client, { ...WT, relativePath: 'a.bin', diffSource: 'unstaged' })
    ).rejects.toThrow('binary_file')
  })

  it('renders a live image preview via files.readPreview', async () => {
    const client = clientOf({
      'files.readPreview': ok({ content: PNG_BASE64, isImage: true, mimeType: 'image/png' })
    })
    const doc = await resolveMobileFileTabDoc(client, { ...WT, relativePath: 'logo.png' })
    expect(doc).toEqual({
      status: 'ready',
      kind: 'image',
      dataUri: `data:image/png;base64,${PNG_BASE64}`
    })
    expect(client.calls).toEqual(['files.readPreview'])
  })

  it('throws binary_file when readPreview returns no image bytes', async () => {
    const client = clientOf({
      'files.readPreview': ok({ content: '', isImage: true, mimeType: 'image/png' })
    })
    await expect(
      resolveMobileFileTabDoc(client, { ...WT, relativePath: 'logo.png' })
    ).rejects.toThrow('binary_file')
  })

  it('renders html source via files.read', async () => {
    const client = clientOf({
      'files.read': ok({ content: '<h1>hi</h1>', truncated: false, byteLength: 11 })
    })
    const doc = await resolveMobileFileTabDoc(client, { ...WT, relativePath: 'page.html' })
    expect(doc).toEqual({ status: 'ready', kind: 'html', content: '<h1>hi</h1>' })
  })

  it('renders a plain text file via files.read', async () => {
    const client = clientOf({
      'files.read': ok({ content: 'hello', truncated: true, byteLength: 5 })
    })
    const doc = await resolveMobileFileTabDoc(client, { ...WT, relativePath: 'notes.txt' })
    expect(doc).toEqual({
      status: 'ready',
      kind: 'file',
      content: 'hello',
      truncated: true,
      byteLength: 5
    })
  })

  // An older client must still surface the host’s oversized-diff error message rather than render an empty diff.
  it('propagates a host diff_too_large failure instead of rendering an empty diff', async () => {
    const client = clientOf({
      'git.diff': fail('diff_too_large', 'This diff is too large to open over a remote connection.')
    })
    await expect(
      resolveMobileFileTabDoc(client, { ...WT, relativePath: 'a.ts', diffSource: 'staged' })
    ).rejects.toThrow('This diff is too large to open over a remote connection.')
  })

  it('propagates the RPC error message when a read fails', async () => {
    const client = clientOf({ 'files.read': fail('EIO', 'file_too_large') })
    await expect(
      resolveMobileFileTabDoc(client, { ...WT, relativePath: 'notes.txt' })
    ).rejects.toThrow('file_too_large')
  })
})
