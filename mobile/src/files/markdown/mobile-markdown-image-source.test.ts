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
})
