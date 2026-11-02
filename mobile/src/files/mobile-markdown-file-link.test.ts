import { describe, expect, it } from 'vitest'
import { routeMarkdownHref } from '../components/markdown-href-routing'
import { mobileMarkdownFileLink } from './mobile-markdown-file-link'

const params = {
  hostId: 'remote-host',
  worktreeId: 'folder-workspace',
  worktreeName: 'Project',
  relativePath: 'docs/notes.md'
}

describe('Markdown preview file links', () => {
  it.each([
    ['details.md', 'docs/details.md'],
    ['./nested/details.md', 'docs/nested/details.md'],
    ['../details.md', 'details.md'],
    ['../docs/details.md', 'docs/details.md'],
    ['nested\\details.md', 'docs/nested/details.md']
  ])('opens %s relative to the current document', (path, relativePath) => {
    expect(mobileMarkdownFileLink(params, path)).toEqual({
      pathname: '/h/[hostId]/files/preview/[worktreeId]',
      params: {
        hostId: 'remote-host',
        worktreeId: 'folder-workspace',
        worktreeName: 'Project',
        source: 'worktree',
        relativePath
      }
    })
  })

  it('preserves decoded filenames and line targets from rendered links', () => {
    const link = routeMarkdownHref('nested/a%20b.md#L12')
    expect(link.kind).toBe('file')
    if (link.kind !== 'file') {
      throw new Error('Expected file link')
    }
    expect(mobileMarkdownFileLink(params, link.pathText)?.params).toMatchObject({
      relativePath: 'docs/nested/a b.md',
      line: '12'
    })
    expect(mobileMarkdownFileLink(params, '../app.ts:3:4')?.params).toMatchObject({
      relativePath: 'app.ts',
      line: '3',
      column: '4'
    })
  })

  it.each(['../../private.md', '/private.md', 'C:\\private.md', '\\\\host\\file.md', '', 'a\0b'])(
    'refuses paths outside the workspace: %s',
    (path) => expect(mobileMarkdownFileLink(params, path)).toBeNull()
  )

  it('does not reuse terminal artifact grants for another file', () => {
    expect(mobileMarkdownFileLink({ ...params, source: 'terminalArtifact' }, 'other.md')).toBeNull()
  })
})
