import {
  isMobileFilePreviewTextResult,
  type MobileFilePreviewResult,
  type MobileFilePreviewSource
} from './mobile-file-preview-request'

export function isEditableMobileTerminalArtifactPreview(
  preview: MobileFilePreviewResult,
  readOnly = false
): boolean {
  if (readOnly) {
    return false
  }
  return (
    (isMobileFilePreviewTextResult(preview) && !preview.truncated) || preview.status === 'empty'
  )
}

export function hasUnsavedMobileTerminalArtifactDraft({
  source,
  draftSourceKey,
  previewSourceKey,
  draftContent,
  savedContent
}: {
  source?: MobileFilePreviewSource['source']
  draftSourceKey: string | null
  previewSourceKey: string | null
  draftContent: string
  savedContent: string
}): boolean {
  return (
    source === 'terminalArtifact' &&
    draftSourceKey === previewSourceKey &&
    draftContent !== savedContent
  )
}

export function shouldKeepDirtyDraftOnPreviewLoadResult(
  preserveDirtyDraft: boolean,
  result: MobileFilePreviewResult
): result is Extract<MobileFilePreviewResult, { status: 'error' | 'waiting' }> {
  return preserveDirtyDraft && (result.status === 'error' || result.status === 'waiting')
}
