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

  it.each([
    ['/remote/project/docs/notes.md', '/remote/project/images/photo.png', 'images/photo.png'],
    ['/docs/notes.md', '/images/photo.png', 'images/photo.png'],
    ['C:\\Project\\docs\\notes.md', 'c:\\project\\images\\photo.png', 'images/photo.png'],
    ['C:\\docs\\notes.md', 'C:\\images\\photo.png', 'images/photo.png'],
    ['\\\\host\\share\\docs\\notes.md', '\\\\host\\share\\images\\photo.png', 'images/photo.png'],
    ['/remote/project/docs/notes.md', '../images/photo.png', 'images/photo.png']
  ])('resolves host paths using the document location %s', (absolute, path, relativePath) => {
    expect(mobileMarkdownFileLink(params, path, absolute)?.params.relativePath).toBe(relativePath)
  })

  it.each([
    '/remote/project-sibling/private.md',
    '../../private.md',
    '/etc/private.md',
    'D:\\private.md'
  ])('rejects a host path outside the known workspace: %s', (path) => {
    expect(mobileMarkdownFileLink(params, path, '/remote/project/docs/notes.md')).toBeNull()
  })

  it('refuses an inconsistent document location', () => {
    expect(mobileMarkdownFileLink(params, 'photo.png', '/different/notes.md')).toBeNull()
  })

  it('folds case only for Windows document locations', () => {
    expect(
      mobileMarkdownFileLink(params, 'photo.png', 'C:\\Project\\Docs\\Notes.md')?.params
        .relativePath
    ).toBe('docs/photo.png')
    expect(mobileMarkdownFileLink(params, 'photo.png', '/remote/project/Docs/Notes.md')).toBeNull()
  })

  it('does not reuse terminal artifact grants for another file', () => {
    expect(mobileMarkdownFileLink({ ...params, source: 'terminalArtifact' }, 'other.md')).toBeNull()
  })
})
