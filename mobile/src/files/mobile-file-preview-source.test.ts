import { describe, expect, it } from 'vitest'
import { previewSourceFromRoute, sourceKeyForPreview } from './mobile-file-preview-source'

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

    expect(first).not.toBe(second)
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
