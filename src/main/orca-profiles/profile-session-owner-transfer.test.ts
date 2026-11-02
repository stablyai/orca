import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { PersistedOpenFile } from '../../shared/workspace-session-state-types'

import { buildMarkdownFrontmatterIdMap } from './profile-session-markdown-transfer'
import { extractSessionOwnersForTransfer } from './profile-session-owner-transfer'

const SOURCE = 'repo-1::/tmp/a'
const editorId = (worktreeId: string, filePath: string, runtime = 'local') =>
  `editor:${encodeURIComponent(worktreeId)}:${runtime}:${encodeURIComponent(filePath)}`

function file(filePath: string, worktreeId = SOURCE): PersistedOpenFile {
  return { filePath, relativePath: filePath.split('/').at(-1)!, worktreeId, language: 'markdown' }
}

describe('session owner transfer', () => {
  it('refuses to guess an override two transferred files both claim', () => {
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
})
