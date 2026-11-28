import { describe, expect, it } from 'vitest'
import { FolderWorkspaceUpdateArgs } from './repo-ipc-arg-schemas'

describe('folder workspace update arguments', () => {
  it('keeps the delivered-note cleanup a renderer sends, instead of stripping it', () => {
    const snapshot = {
      id: 'sample-note',
      body: 'Sample note',
      filePath: 'docs/plan.md',
      lineNumber: 3,
      source: 'markdown' as const
    }
    const parsed = FolderWorkspaceUpdateArgs.parse({
      folderWorkspaceId: 'sample-folder',
      updates: { deliveredDiffCommentSnapshots: [snapshot] }
    })
    expect(parsed.updates.deliveredDiffCommentSnapshots).toEqual([snapshot])
  })
})
