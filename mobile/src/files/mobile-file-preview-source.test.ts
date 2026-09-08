import { describe, expect, it } from 'vitest'
import {
  previewSourceFromRoute,
  sourceKeyForPreview,
  sourceRevisionForPreview
} from './mobile-file-preview-source'

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

  it('tracks refreshed terminal capabilities separately from file identity', () => {
    const original = {
      source: 'terminalArtifact' as const,
      worktreeId: 'wt:1',
      absolutePath: '/tmp/result.json',
      grantId: 'grant-1'
    }
    const refreshed = { ...original, grantId: 'grant-2' }

    expect(sourceKeyForPreview(original)).toBe(sourceKeyForPreview(refreshed))
    expect(sourceRevisionForPreview(original)).not.toBe(sourceRevisionForPreview(refreshed))
  })

  it('makes native-chat artifact previews read-only', () => {
    expect(
      previewSourceFromRoute({
        hostId: 'host-1',
        worktreeId: 'wt-1',
        source: 'terminalArtifact',
        absolutePath: '/tmp/result.html',
        grantId: 'grant-1',
        nativeChatTab: 'tab-1',
        nativeChatSession: 'session-1'
      })
    ).toMatchObject({
      nativeChatContext: { tabId: 'tab-1', sessionId: 'session-1' },
      readOnly: true
    })
  })
})
