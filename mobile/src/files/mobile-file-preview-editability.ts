import type {
  MobileFilePreviewResult,
  MobileFilePreviewSource
} from './mobile-file-preview-request'

export function isEditableMobileTerminalArtifactPreview(preview: MobileFilePreviewResult): boolean {
  return (
    (preview.status === 'ready' && preview.kind !== 'image' && !preview.truncated) ||
    preview.status === 'empty'
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
