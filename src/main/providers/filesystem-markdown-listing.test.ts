import { expect, it, vi } from 'vitest'
import { listFilesystemMarkdownDocuments } from './filesystem-markdown-listing'

it('retains the path-list fallback for providers without native markdown listing', async () => {
  const listFiles = vi.fn(async () => ['b.mdx', 'ignored.ts', '../escape.md', 'a.md'])
  const documents = await listFilesystemMarkdownDocuments({ listFiles }, '/repo')
  expect(documents.map((document) => document.relativePath)).toEqual(['a.md', 'b.mdx'])
  expect(listFiles).toHaveBeenCalledWith('/repo')
})

it('keeps late Markdown documents from path-list providers with large source inventories', async () => {
  const paths = Array.from({ length: 25_002 }, (_, index) => `src/file-${index}.ts`)
  paths.push('docs/late.md')
  const listFiles = vi.fn(async () => paths)
  await expect(listFilesystemMarkdownDocuments({ listFiles }, '/repo')).resolves.toEqual([
    {
      filePath: '/repo/docs/late.md',
      relativePath: 'docs/late.md',
      basename: 'late.md',
      name: 'late'
    }
  ])
})

it('still bounds path-list inventories before constructing Markdown metadata', async () => {
  const listFiles = vi.fn(async () => [`${'x'.repeat(65_537)}.ts`, 'README.md'])
  await expect(listFilesystemMarkdownDocuments({ listFiles }, '/repo')).rejects.toThrow(
    'File inventory is too large'
  )
})
