import { translate } from '../../i18n/mobile-i18n'
import { formatPreviewByteLength } from '../mobile-file-preview-response'
import type { MarkdownDocState } from './session-document-state'

export function markdownReaderStatusText(
  doc: Extract<MarkdownDocState, { status: 'ready' }>
): string | null {
  if (doc.saveError) {
    return doc.saveError
  }
  if (doc.truncated) {
    return doc.byteLength === undefined
      ? translate('session.markdownReader.previewTruncated', 'Preview truncated.')
      : translate(
          'files.filePreviewSourceText.truncatedNote',
          'Preview truncated. File size: {{size}}.',
          { size: formatPreviewByteLength(doc.byteLength) }
        )
  }
  if (doc.readOnlyReason) {
    return translate('session.markdownReader.readOnly', 'Read only')
  }
  return doc.stale
    ? translate('session.markdownReader.changedOnDesktop', 'Changed on desktop')
    : null
}
