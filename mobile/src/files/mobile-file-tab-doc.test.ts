import { describe, expect, it } from 'vitest'
import type { RpcResponse } from '../transport/types'
import { resolveMobileFileTabDoc } from './mobile-file-tab-doc'

function ok(result: unknown): RpcResponse {
  return { id: 'x', ok: true, result, _meta: { runtimeId: 'r' } }
}

function fail(code: string, message: string): RpcResponse {
  return { id: 'x', ok: false, error: { code, message }, _meta: { runtimeId: 'r' } }
}

// Fake client that returns a canned response per RPC method.
function clientOf(byMethod: Record<string, RpcResponse>): {
  sendRequest: (method: string) => Promise<RpcResponse>
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    sendRequest: (method: string) => {
      calls.push(method)
      const response = byMethod[method]
      if (!response) {
        throw new Error(`unexpected method ${method}`)
      }
      return Promise.resolve(response)
    }
  }
}

const WT = { worktreeId: 'wt1' }

function pngBase64(width = 1): string {
  const bytes = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(1, 20)
  return bytes.toString('base64')
}

describe('resolveMobileFileTabDoc', () => {
  it('renders a staged text diff', async () => {
    const client = clientOf({
      'git.diff': ok({ kind: 'text', originalContent: 'a\n', modifiedContent: 'a\nb\n' })
    })
    const doc = await resolveMobileFileTabDoc(client, {
      ...WT,
      relativePath: 'a.ts',
      diffSource: 'staged'
    })
    expect(doc.kind).toBe('diff')
    expect(client.calls).toEqual(['git.diff'])
  })

  it('renders an unstaged image diff from the modified bytes', async () => {
    const modifiedContent = pngBase64()
    const client = clientOf({
      'git.diff': ok({
        kind: 'binary',
        originalContent: 'b2xk',
        modifiedContent,
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
      dataUri: `data:image/png;base64,${modifiedContent}`
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
    const content = pngBase64()
    const client = clientOf({
      'files.readPreview': ok({ content, isImage: true, mimeType: 'image/png' })
    })
    const doc = await resolveMobileFileTabDoc(client, { ...WT, relativePath: 'logo.png' })
    expect(doc).toEqual({
      status: 'ready',
      kind: 'image',
      dataUri: `data:image/png;base64,${content}`
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

  it('propagates the RPC error message when a read fails', async () => {
    const client = clientOf({ 'files.read': fail('EIO', 'file_too_large') })
    await expect(
      resolveMobileFileTabDoc(client, { ...WT, relativePath: 'notes.txt' })
    ).rejects.toThrow('file_too_large')
  })
})
