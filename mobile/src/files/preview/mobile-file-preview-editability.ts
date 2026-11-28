import { getUtf8ByteLength } from '../../../../src/shared/text/utf8-byte-limits'
import type { MobileFilePreviewResult } from './mobile-file-preview-response'

/** Whole text the phone can round-trip; U+FFFD may stand for bytes the read could not decode, which the host refuses to save over. */
export function isEditableMobileFilePreview(
  preview: MobileFilePreviewResult,
  readOnly = false
): boolean {
  if (readOnly) {
    return false
  }
  return (
    (preview.status === 'ready' &&
      preview.kind !== 'image' &&
      preview.kind !== 'media' &&
      !preview.truncated &&
      !preview.content.includes('�')) ||
    preview.status === 'empty'
  )
}

export function hasUnsavedMobileFilePreviewDraft({
  draftSourceKey,
  previewSourceKey,
  draftContent,
  savedContent
}: {
  draftSourceKey: string | null
  previewSourceKey: string | null
  draftContent: string
  savedContent: string
}): boolean {
  return draftSourceKey === previewSourceKey && draftContent !== savedContent
}

export function shouldKeepDirtyDraftOnPreviewLoadResult(
  preserveDirtyDraft: boolean,
  result: MobileFilePreviewResult
): result is Extract<MobileFilePreviewResult, { status: 'error' | 'waiting' }> {
  return preserveDirtyDraft && (result.status === 'error' || result.status === 'waiting')
}

export function terminalArtifactPreviewMatchesBase(
  preview: MobileFilePreviewResult,
  baseContent: string
): boolean {
  if (preview.status === 'empty') {
    return baseContent.length === 0
  }
  return (
    preview.status === 'ready' &&
    preview.kind !== 'image' &&
    preview.kind !== 'media' &&
    preview.content === baseContent
  )
}

/** The file text a preview holds; null when it is not whole, editable text. */
export function fileTextOfPreview(preview: MobileFilePreviewResult): string | null {
  if (!isEditableMobileFilePreview(preview)) {
    return null
  }
  return preview.status === 'ready' && 'content' in preview ? preview.content : ''
}

/** The preview after a save wrote `fileText`, so leaving the editor shows what disk now holds. */
export function previewWithSavedText(
  preview: MobileFilePreviewResult,
  fileText: string
): MobileFilePreviewResult {
  if ((preview.status !== 'ready' && preview.status !== 'empty') || !('kind' in preview)) {
    return preview
  }
  if (preview.kind === 'image' || preview.kind === 'media') {
    return preview
  }
  return fileText.length === 0
    ? { status: 'empty', kind: preview.kind }
    : {
        status: 'ready',
        kind: preview.kind,
        content: fileText,
        truncated: false,
        byteLength: getUtf8ByteLength(fileText)
      }
}
