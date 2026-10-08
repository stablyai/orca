import { describe, expect, it } from 'vitest'
import type { PersistedOpenFile } from '../../shared/workspace-session-state-types'
import { isHostEditRowInsideWorkspace } from './host-editor-tab-projection'

function row(filePath: string, relativePath: string): PersistedOpenFile {
  return { filePath, relativePath, worktreeId: 'repo::root', language: 'markdown' }
}

describe('isHostEditRowInsideWorkspace', () => {
  it.each([
    [
      'a terminal link with other letter case under a Windows root',
      'C:\\repo',
      'C:/Repo/docs/a.md'
    ],
    ['a Windows root stored with a lowercase drive', 'c:\\repo', 'C:\\repo\\docs\\a.md'],
    ['an SSH POSIX root', '/srv/notes', '/srv/notes/docs/a.md'],
    [
      'a WSL UNC root through the other alias',
      '\\\\wsl.localhost\\Ubuntu\\home\\u\\repo',
      '//wsl$/Ubuntu/home/u/repo/docs/a.md'
    ]
  ])('lists %s', (_label, root, filePath) => {
    expect(isHostEditRowInsideWorkspace(row(filePath, 'docs/a.md'), root)).toBe(true)
  })

  it.each([
    ['a POSIX root, whose names are case-sensitive', '/srv/notes', '/srv/Notes/docs/a.md'],
    [
      'a WSL root, whose Linux names are case-sensitive',
      '\\\\wsl$\\Ubuntu\\repo',
      '\\\\wsl$\\Ubuntu\\Repo\\docs\\a.md'
    ],
    ['a row naming another workspace', 'C:\\repo', 'C:\\other\\docs\\a.md']
  ])('hides %s', (_label, root, filePath) => {
    expect(isHostEditRowInsideWorkspace(row(filePath, 'docs/a.md'), root)).toBe(false)
  })
})
