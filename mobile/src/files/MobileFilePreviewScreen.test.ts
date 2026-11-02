import { describe, expect, it } from 'vitest'
import { sourceKeyForPreview } from './mobile-file-preview-source'
import {
  hasUnsavedMobileTerminalArtifactDraft,
  isEditableMobileTerminalArtifactPreview,
  shouldKeepDirtyDraftOnPreviewLoadResult
} from './mobile-file-preview-editability'

describe('mobile file preview editability and dirty-draft policy', () => {
  it('treats empty terminal artifact text previews as editable', () => {
    expect(isEditableMobileTerminalArtifactPreview({ status: 'empty', kind: 'text' })).toBe(true)
    expect(
      isEditableMobileTerminalArtifactPreview({
        status: 'ready',
        kind: 'text',
        content: '',
        truncated: false,
        byteLength: 0
      })
    ).toBe(true)
    expect(
      isEditableMobileTerminalArtifactPreview({
        status: 'ready',
        kind: 'image',
        dataUri: 'data:image/png;base64,aW1n'
      })
    ).toBe(false)
  })

  it('treats truncated terminal artifact text previews as read-only', () => {
    expect(
      isEditableMobileTerminalArtifactPreview({
        status: 'ready',
        kind: 'text',
        content: 'partial',
        truncated: true,
        byteLength: 1024
      })
    ).toBe(false)
  })

  it('treats native-chat artifact grants as read-only', () => {
    expect(
      isEditableMobileTerminalArtifactPreview(
        {
          status: 'ready',
          kind: 'text',
          content: '<h1>Result</h1>',
          truncated: false,
          byteLength: 15
        },
        true
      )
    ).toBe(false)
  })

  it('recognizes only changed terminal artifact drafts for the active source', () => {
    const sourceKey = sourceKeyForPreview({
      source: 'terminalArtifact',
      worktreeId: 'wt-1',
      absolutePath: '/tmp/result.json',
      grantId: 'grant-1'
    })

    const draft = {
      source: 'terminalArtifact' as const,
      draftSourceKey: sourceKey,
      previewSourceKey: sourceKey,
      draftContent: '{"ok":false}',
      savedContent: '{"ok":true}'
    }
    expect(hasUnsavedMobileTerminalArtifactDraft(draft)).toBe(true)
    expect(
      hasUnsavedMobileTerminalArtifactDraft({ ...draft, previewSourceKey: 'other-file' })
    ).toBe(false)
    expect(
      hasUnsavedMobileTerminalArtifactDraft({ ...draft, draftContent: draft.savedContent })
    ).toBe(false)
    expect(hasUnsavedMobileTerminalArtifactDraft({ ...draft, source: undefined })).toBe(false)
  })

  it('keeps dirty terminal artifact drafts when a reload fails or waits', () => {
    expect(
      shouldKeepDirtyDraftOnPreviewLoadResult(true, {
        status: 'error',
        message: 'Unable to reach desktop filesystem',
        reconnect: true
      })
    ).toBe(true)
    expect(
      shouldKeepDirtyDraftOnPreviewLoadResult(true, {
        status: 'waiting',
        message: 'Waiting for desktop...',
        reconnect: true
      })
    ).toBe(true)
    expect(
      shouldKeepDirtyDraftOnPreviewLoadResult(false, {
        status: 'error',
        message: 'Unable to load preview',
        reconnect: false
      })
    ).toBe(false)
  })
})
