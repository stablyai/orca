import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { PersistedOpenFile } from '../../shared/workspace-session-state-types'
import { mergeWorkspaceSessions } from './profile-project-session-state'
import { extractSessionForTransfer } from './profile-project-session-transfer'
import { buildMarkdownFrontmatterIdMap } from './profile-session-markdown-transfer'
import { extractSessionOwnersForTransfer } from './profile-session-owner-transfer'

const SOURCE = 'repo-1::/tmp/a'
const DESTINATION = 'repo-9::/tmp/a'
const editorId = (worktreeId: string, filePath: string, runtime = 'local') =>
  `editor:${encodeURIComponent(worktreeId)}:${runtime}:${encodeURIComponent(filePath)}`

function file(filePath: string, worktreeId = SOURCE): PersistedOpenFile {
  return { filePath, relativePath: filePath.split('/').at(-1)!, worktreeId, language: 'markdown' }
}

describe('session owner transfer', () => {
  it('moves a hidden override keyed by the owned editor id to the destination worktree', () => {
    const session = {
      ...getDefaultWorkspaceSession(),
      openFilesByWorktree: { [SOURCE]: [file('/tmp/a/README.md')] },
      markdownFrontmatterVisible: {
        [editorId(SOURCE, '/tmp/a/README.md')]: false,
        // Visible is the hydration default, so it is not carried.
        '/tmp/a/README.md': true
      }
    }

    const result = extractSessionForTransfer(session, 'repo-1', 'repo-9')

    expect(result.markdownFrontmatterVisible).toEqual({
      [editorId(DESTINATION, '/tmp/a/README.md')]: false
    })
  })

  it('refuses to guess an override two transferred files both claim', () => {
    // Two host-qualified owners of one worktree each claim its unqualified editor id.
    const owners = { [`h1|${SOURCE}`]: 'repo-9::/tmp/h1', [`h2|${SOURCE}`]: 'repo-9::/tmp/h2' }
    const projection = {
      mapOwnerKey: (key: string) => owners[key] ?? null,
      mapWorktreeId: (key: string) => owners[key] ?? key
    }
    const files = {
      [`h1|${SOURCE}`]: [file('/tmp/a/x.md')],
      [`h2|${SOURCE}`]: [file('/tmp/a/x.md')]
    }

    expect(
      buildMarkdownFrontmatterIdMap(files, projection).get(editorId(SOURCE, '/tmp/a/x.md'))
    ).toBe(null)
    const visibility = extractSessionOwnersForTransfer(
      {
        ...getDefaultWorkspaceSession(),
        openFilesByWorktree: files,
        markdownFrontmatterVisible: { [editorId(SOURCE, '/tmp/a/x.md')]: false }
      },
      projection
    ).markdownFrontmatterVisible

    expect(visibility).toEqual({})
  })

  it('carries a worktree focus key and lets the destination merge keep its own overrides', () => {
    const transferred = extractSessionForTransfer(
      {
        ...getDefaultWorkspaceSession(),
        activeWorkspaceKey: `worktree:${SOURCE}`,
        openFilesByWorktree: { [SOURCE]: [file('/tmp/a/README.md')] },
        markdownFrontmatterVisible: { '/tmp/a/README.md': false }
      },
      'repo-1',
      'repo-9'
    )
    expect(transferred.activeWorkspaceKey).toBe(`worktree:${DESTINATION}`)

    const merged = mergeWorkspaceSessions(
      { ...getDefaultWorkspaceSession(), markdownFrontmatterVisible: { '/other.md': false } },
      transferred
    )

    expect(merged.markdownFrontmatterVisible).toEqual({
      '/other.md': false,
      '/tmp/a/README.md': false
    })
  })
})
