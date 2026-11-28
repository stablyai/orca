import type { Translate } from '../../i18n/mobile-i18n'
import type { SupportedUiLocale } from '../../../../src/shared/i18n/ui-locale'
import { formatPreviewByteLength } from '../preview/mobile-file-preview-response'
import type { MarkdownDocState } from './session-document-state'

export function markdownReaderStatusText(
  doc: Extract<MarkdownDocState, { status: 'ready' }>,
  t: Translate,
  locale: SupportedUiLocale
): string | null {
  if (doc.saveError) {
    return doc.saveError
  }
  if (doc.truncated) {
    return doc.byteLength === undefined
      ? t('session.markdownReader.previewTruncated', 'Preview truncated.')
      : t('files.filePreviewSourceText.truncatedNote', 'Preview truncated. File size: {{size}}.', {
          size: formatPreviewByteLength(doc.byteLength, t, locale)
        })
  }
  if (doc.readOnlyReason) {
    return t('session.markdownReader.readOnly', 'Read only')
  }
  return doc.stale ? t('session.markdownReader.changedOnDesktop', 'Changed on desktop') : null
}
