import { describe, expect, it } from 'vitest'
import { sourceKeyForPreview } from './mobile-file-preview-source'

describe('mobile-file-preview-source', () => {
  it('uses structured preview keys so colons in paths cannot collide', () => {
    const first = sourceKeyForPreview({
      source: 'terminalArtifact',
      worktreeId: 'wt:1',
      absolutePath: '/tmp/a',
      grantId: 'grant-1',
      terminalHandle: 'b:c'
    })
    const second = sourceKeyForPreview({
      source: 'terminalArtifact',
      worktreeId: 'wt',
      absolutePath: '1:/tmp/a:b',
      grantId: 'grant-2',
      terminalHandle: 'c'
    })

    expect(first).toBe(JSON.stringify(['terminal', 'wt:1', '/tmp/a', 'b:c']))
    expect(second).toBe(JSON.stringify(['terminal', 'wt', '1:/tmp/a:b', 'c']))
    expect(first).not.toBe(second)
    expect(
      sourceKeyForPreview({ source: 'worktree', worktreeId: 'wt:1', relativePath: 'a:b.ts' })
    ).toBe(JSON.stringify(['worktree', 'wt:1', 'a:b.ts']))
  })
})
