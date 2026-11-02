import { describe, expect, it, vi } from 'vitest'
import { loadMarkdownPreviewImage } from './mobile-markdown-image-source'

function host() {
  return {
    sendRequest: vi.fn(async () => ({
      id: '1',
      ok: true as const,
      _meta: { runtimeId: 'remote' },
      result: { content: 'cG5n', isBinary: true, isImage: true, mimeType: 'image/png' }
    }))
  }
}

describe('Markdown preview images', () => {
  it.each([
    ['architecture.png', 'docs/architecture.png'],
    ['../assets/a%20b.png', 'assets/a b.png'],
    ['nested\\image.png', 'docs/nested/image.png']
  ])(
    'reads %s relative to the document through the workspace client',
    async (href, relativePath) => {
      const client = host()
      await expect(
        loadMarkdownPreviewImage(client, 'folder-workspace', 'docs/readme.md', href)
      ).resolves.toBe('data:image/png;base64,cG5n')
      expect(client.sendRequest).toHaveBeenCalledWith('files.readPreview', {
        worktree: 'id:folder-workspace',
        relativePath
      })
    }
  )

  it.each([
    '../../private.png',
    '/private.png',
    'C:\\private.png',
    'file:///tmp/private.png',
    'javascript:alert(1)',
    'notes.txt'
  ])('does not read unauthorized or unsupported image locations: %s', async (href) => {
    const client = host()
    await expect(loadMarkdownPreviewImage(client, 'wt', 'docs/readme.md', href)).rejects.toThrow()
    expect(client.sendRequest).not.toHaveBeenCalled()
  })

  it.each(['/Users/me/notes/readme.md', 'C:\\notes\\readme.md'])(
    'does not read workspace images for a document outside the workspace: %s',
    async (documentPath) => {
      const client = host()
      await expect(
        loadMarkdownPreviewImage(client, 'wt', documentPath, 'images/d.png')
      ).rejects.toThrow()
      expect(client.sendRequest).not.toHaveBeenCalled()
    }
  )

  it('draws an SVG from its source text, since hosts read SVG as text', async () => {
    const markup = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"/>'
    const client = {
      sendRequest: vi.fn(async () => ({
        id: '1',
        ok: true as const,
        _meta: { runtimeId: 'remote' },
        result: { content: markup, truncated: false, byteLength: markup.length }
      }))
    }
    await expect(
      loadMarkdownPreviewImage(client, 'wt', 'docs/readme.md', 'logo.svg')
    ).resolves.toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`)
    expect(client.sendRequest).toHaveBeenCalledWith('files.read', {
      worktree: 'id:wt',
      relativePath: 'docs/logo.svg'
    })
  })

  it('lets native Image load public URLs without sending them to the workspace host', async () => {
    const client = host()
    await expect(
      loadMarkdownPreviewImage(client, 'wt', 'readme.md', 'https://example.com/a.png')
    ).resolves.toBe('https://example.com/a.png')
    expect(client.sendRequest).not.toHaveBeenCalled()
  })

  it('reports a disconnected host instead of trying to read phone-local files', async () => {
    await expect(loadMarkdownPreviewImage(null, 'wt', 'readme.md', 'a.png')).rejects.toThrow(
      'Waiting for desktop'
    )
  })
})
